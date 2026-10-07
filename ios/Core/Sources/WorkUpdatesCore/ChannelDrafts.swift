import Foundation
import CryptoKit

public struct DraftBinding: Codable, Equatable, Hashable, Sendable {
    public let computerID: String
    public let hostID: String
    public let sourceID: String
    public let taskKey: String
    public let contextRevision: String?
    public init(computerID: String, hostID: String, sourceID: String, taskKey: String, contextRevision: String?) {
        self.computerID=computerID; self.hostID=hostID; self.sourceID=sourceID
        self.taskKey=taskKey; self.contextRevision=contextRevision
    }
}
public struct ChannelDraft: Codable, Sendable {
    public let id: String
    public let binding: DraftBinding
    public var text: String
    public var revision: Int
    public var updatedAt: Double
    public var messageID: String?
    public var submittedText: String?
    public var submittedRevision: Int?
    public var status: String
}
public struct ChannelReceipt: Codable, Sendable {
    public let messageID: String
    public let binding: DraftBinding
    public let textHash: String
    public let delivery: String
    public let turnID: String?
    public let at: Double
}
private struct DraftJournal: Codable {
    var version=1
    var drafts:[ChannelDraft]=[]
    var receipts:[ChannelReceipt]=[]
}
// Called by WorkStore on the main actor; disk failures preserve the old journal.
public final class ChannelDrafts {
    public let file: URL
    private var state=DraftJournal()
    private var diskHash: String?
    private var failed=false
    private let now: () -> Double
    private let write: (Data,URL) throws -> Void
    public init(file: URL, now: @escaping () -> Double = {Date().timeIntervalSince1970},
                write: @escaping (Data,URL) throws -> Void = ChannelDrafts.protectedWrite) throws {
        self.file=file; self.now=now; self.write=write
        if FileManager.default.fileExists(atPath:file.path) {
            let values=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max)<=2*1024*1024 else {throw PeerError.server("The saved phone draft journal needs recovery. Its original file is preserved.")}
            let bytes=try Data(contentsOf:file)
            state=try JSONDecoder().decode(DraftJournal.self,from:bytes); try validate(state)
            diskHash=Self.hash(bytes)
            if state.drafts.contains(where:{["prepared","sending"].contains($0.status)}) {
                try change {value in for index in value.drafts.indices where ["prepared","sending"].contains(value.drafts[index].status) {value.drafts[index].status="unconfirmed"}}
            }
        }
    }
    public static func protectedWrite(_ data: Data,_ file: URL) throws {
        try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
        #if os(iOS)
        try data.write(to:file,options:[.atomic,.completeFileProtection])
        #else
        try data.write(to:file,options:.atomic)
        #endif
        var target=file
        var values=URLResourceValues(); values.isExcludedFromBackup=true
        try target.setResourceValues(values)
    }
    private static func hash(_ bytes:Data)->String {SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
    private func validBinding(_ binding:DraftBinding)->Bool {
        [binding.computerID,binding.hostID,binding.sourceID,binding.taskKey].allSatisfy({!$0.isEmpty && $0.count<=512}) &&
        (binding.contextRevision.map({!$0.isEmpty && $0.count<=512}) ?? true)
    }
    private func validate(_ value:DraftJournal) throws {
        guard value.version==1,value.drafts.count<=128,value.receipts.count<=512,
              Set(value.drafts.map(\.id)).count==value.drafts.count,
              Set(value.drafts.map(\.binding)).count==value.drafts.count,
              Set(value.receipts.map(\.messageID)).count==value.receipts.count,
              Set(value.drafts.compactMap(\.messageID)).count==value.drafts.compactMap(\.messageID).count else {throw PeerError.server("Unsupported or full phone draft journal. The original file is preserved.")}
        for draft in value.drafts {
            guard UUID(uuidString:draft.id) != nil,draft.text.utf16.count<=12000,draft.revision>=0,draft.updatedAt.isFinite,
                  ["idle","prepared","sending","unconfirmed","accepted","not_sent"].contains(draft.status),
                  validBinding(draft.binding) else {throw PeerError.server("Invalid saved phone draft. The original file is preserved.")}
            if ["prepared","sending","unconfirmed","accepted"].contains(draft.status) {
                guard draft.messageID.flatMap({UUID(uuidString:$0)}) != nil,
                      let text=draft.submittedText,!text.isEmpty,text.utf16.count<=12000,
                      let revision=draft.submittedRevision,revision>=0,revision<=draft.revision else {throw PeerError.server("Invalid retained phone delivery intent.")}
            }
            if draft.status=="accepted" {
                guard let receipt=value.receipts.first(where:{$0.messageID==draft.messageID}),receipt.binding==draft.binding,
                      receipt.textHash==Self.hash(Data((draft.submittedText ?? "").utf8)) else {throw PeerError.server("The saved delivery has no matching receipt. Sending is held.")}
            }
        }
        for receipt in value.receipts {
            guard UUID(uuidString:receipt.messageID) != nil,receipt.textHash.count==64,
                  receipt.textHash.allSatisfy({"0123456789abcdef".contains($0)}),validBinding(receipt.binding),
                  receipt.at.isFinite,["sent","cancelled"].contains(receipt.delivery),
                  (receipt.turnID.map({!$0.isEmpty && $0.count<=512}) ?? (receipt.delivery != "sent")) else {throw PeerError.server("Invalid phone delivery receipt.")}
        }
    }
    private func change(_ update:(inout DraftJournal)throws->Void) throws {
        guard !failed else {throw PeerError.server("Phone draft storage needs recovery. Sending is held.")}
        let current=FileManager.default.fileExists(atPath:file.path) ? try Self.hash(Data(contentsOf:file)) : nil
        guard current==diskHash else {failed=true;throw PeerError.server("The phone draft journal changed outside its owner. Sending is held.")}
        var next=state;try update(&next);try validate(next)
        let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
        let bytes=try encoder.encode(next)
        guard bytes.count<=2*1024*1024 else {throw PeerError.server("The phone draft journal is full. Sending is held.")}
        do {try write(bytes,file);let saved=try Data(contentsOf:file);guard saved==bytes else {throw PeerError.server("Phone draft save was not confirmed.")};state=next;diskHash=Self.hash(saved)}
        catch {failed=true;throw error}
    }
    public func draft(_ binding:DraftBinding)->ChannelDraft? {state.drafts.first{$0.binding==binding}}
    public func receipts(computerID:String)->[ChannelReceipt] {state.receipts.filter{$0.binding.computerID==computerID}.suffix(32).map{$0}}
    public func hasUnconfirmed(computerID:String,hostID:String,sourceID:String)->Bool {
        state.drafts.contains{ $0.binding.computerID==computerID && $0.binding.hostID==hostID && $0.binding.sourceID==sourceID && ["prepared","sending","unconfirmed"].contains($0.status) }
    }
    public func save(_ binding:DraftBinding,text:String) throws {
        guard !failed else {throw PeerError.server("Phone draft storage needs recovery. Sending is held.")}
        if draft(binding)==nil && text.isEmpty {return}
        if let current=draft(binding),current.text==text {return}
        try change {value in
            if let index=value.drafts.firstIndex(where:{$0.binding==binding}) {value.drafts[index].text=text;value.drafts[index].revision+=1;value.drafts[index].updatedAt=now()}
            else {value.drafts.append(ChannelDraft(id:UUID().uuidString.lowercased(),binding:binding,text:text,revision:0,updatedAt:now(),messageID:nil,submittedText:nil,submittedRevision:nil,status:"idle"))}
        }
    }
    public func prepare(_ binding:DraftBinding) throws -> ChannelDraft {
        guard !hasUnconfirmed(computerID:binding.computerID,hostID:binding.hostID,sourceID:binding.sourceID),let old=draft(binding),!old.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {throw PeerError.server("Check this source's unconfirmed delivery before sending. Its saved draft is retained.")}
        try change {value in let index=value.drafts.firstIndex{$0.id==old.id}!
            value.drafts[index].messageID=UUID().uuidString.lowercased();value.drafts[index].submittedText=old.text.trimmingCharacters(in:.whitespacesAndNewlines)
            value.drafts[index].submittedRevision=old.revision;value.drafts[index].status="prepared"}
        return draft(binding)!
    }
    public func sending(_ binding:DraftBinding,messageID:String) throws {
        try change {value in guard let index=value.drafts.firstIndex(where:{$0.binding==binding && $0.messageID==messageID && $0.status=="prepared"}) else {throw PeerError.uncertainDelivery};value.drafts[index].status="sending"}
    }
    public func failed(_ binding:DraftBinding,messageID:String,notSent:Bool) throws {
        try change {value in guard let index=value.drafts.firstIndex(where:{$0.binding==binding && $0.messageID==messageID && ["prepared","sending","unconfirmed"].contains($0.status)}) else {throw PeerError.uncertainDelivery};value.drafts[index].status=notSent ? "not_sent":"unconfirmed"}
    }
    public func accepted(_ binding:DraftBinding,messageID:String,result:JSONValue) throws {
        let receipt=try DeliveryReceipt.decode(result,messageID:messageID,sourceID:binding.sourceID)
        guard ["sent","cancelled"].contains(receipt.delivery),let old=draft(binding),old.messageID==messageID,let submitted=old.submittedText else {throw PeerError.uncertainDelivery}
        try change {value in
            if let prior=value.receipts.first(where:{$0.messageID==messageID}) {guard prior.binding==binding && prior.delivery==receipt.delivery && prior.turnID==receipt.turnID else {throw PeerError.uncertainDelivery};return}
            value.receipts.append(ChannelReceipt(messageID:messageID,binding:binding,textHash:Self.hash(Data(submitted.utf8)),delivery:receipt.delivery,turnID:receipt.turnID,at:now()))
            let index=value.drafts.firstIndex{$0.id==old.id}!
            value.drafts[index].status="accepted"
            if receipt.delivery=="sent" && old.revision==old.submittedRevision && old.text.trimmingCharacters(in:.whitespacesAndNewlines)==submitted {value.drafts[index].text="";value.drafts[index].revision+=1}
        }
    }
    public func reconcile(computerID:String,hostID:String,sources:[ChatSource]) throws {
        for old in state.drafts where old.binding.computerID==computerID && old.binding.hostID==hostID && ["sending","unconfirmed"].contains(old.status) {
            guard let messageID=old.messageID,let source=sources.first(where:{$0.id==old.binding.sourceID}),
                  let outcome=source.deliveryOutcomes?.first(where:{$0.object?["messageId"]?.string==messageID && $0.object?["sourceId"]?.string==old.binding.sourceID}),
                  let fields=outcome.object,let status=fields["status"]?.string,["sent","cancelled"].contains(status) else {continue}
            var proof=fields;proof["delivery"] = .string(status)
            try accepted(old.binding,messageID:messageID,result:.object(proof))
        }
    }
}
