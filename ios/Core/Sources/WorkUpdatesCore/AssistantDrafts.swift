import Foundation
import CryptoKit

public struct AssistantDraft:Codable,Sendable {
    public let channelID:String;public let hostID:String;public let id:String;public let text:String;public var status:String
}
private struct AssistantDraftJournal:Codable {var version=1;var drafts:[AssistantDraft]=[];var receipts:[String:String]=[:]}
public final class AssistantDrafts {
    private let file:URL
    private var state=AssistantDraftJournal()
    private var diskHash:String?
    private var failed=false
    private static func hash(_ data:Data)->String {SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()}
    public init(file:URL) throws {
        self.file=file
        if FileManager.default.fileExists(atPath:file.path) {
            let info=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
            guard info.isRegularFile==true,info.isSymbolicLink != true,(info.fileSize ?? Int.max)<=262144 else {throw PeerError.unsupportedState}
            let bytes=try Data(contentsOf:file);state=try JSONDecoder().decode(AssistantDraftJournal.self,from:bytes);try validate(state);diskHash=Self.hash(bytes)
            if state.drafts.contains(where:{$0.status=="sending"}) {try change {for i in $0.drafts.indices where $0.drafts[i].status=="sending" {$0.drafts[i].status="unconfirmed"}}}
        }
    }
    private func validate(_ value:AssistantDraftJournal) throws {
        guard value.version==1,value.drafts.count<=32,value.receipts.count<=512,
              Set(value.drafts.map{$0.channelID}).count==value.drafts.count,
              value.drafts.allSatisfy({UUID(uuidString:$0.id) != nil && UUID(uuidString:$0.channelID) != nil && UUID(uuidString:$0.hostID) != nil && !$0.text.isEmpty && $0.text.utf16.count<=4000 && ["sending","unconfirmed"].contains($0.status)}),
              value.receipts.allSatisfy({UUID(uuidString:$0.key) != nil && $0.value.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil}) else {throw PeerError.unsupportedState}
    }
    private func change(_ update:(inout AssistantDraftJournal)throws->Void) throws {
        guard !failed else {throw PeerError.uncertainDelivery}
        if FileManager.default.fileExists(atPath:file.path) {
            let info=try file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
            guard info.isRegularFile==true,info.isSymbolicLink != true,(info.fileSize ?? Int.max)<=262144 else {failed=true;throw PeerError.uncertainDelivery}
        }
        let current=FileManager.default.fileExists(atPath:file.path) ? try Self.hash(Data(contentsOf:file)) : nil
        guard current==diskHash else {failed=true;throw PeerError.uncertainDelivery}
        var next=state;try update(&next);try validate(next);let bytes=try JSONEncoder().encode(next)
        guard bytes.count<=262144 else {throw PeerError.responseTooLarge}
        do {try ChannelDrafts.protectedWrite(bytes,file);guard try Data(contentsOf:file)==bytes else {throw PeerError.uncertainDelivery}
            state=next;diskHash=Self.hash(bytes)}catch{failed=true;throw error}
    }
    public func pending(_ code:AssistantChannelCode)->AssistantDraft? {state.drafts.first{$0.channelID==code.channelID && $0.hostID==code.hostID}}
    public func prepare(_ code:AssistantChannelCode,text:String) throws -> AssistantDraft {
        guard pending(code)==nil,!text.isEmpty,text.utf16.count<=4000,state.receipts.count<512 else {throw PeerError.uncertainDelivery}
        let draft=AssistantDraft(channelID:code.channelID,hostID:code.hostID,id:UUID().uuidString.lowercased(),text:text,status:"sending")
        try change{$0.drafts.append(draft)};return draft
    }
    public func uncertain(_ code:AssistantChannelCode,id:String) throws {try change {value in
        guard let i=value.drafts.firstIndex(where:{$0.channelID==code.channelID && $0.hostID==code.hostID && $0.id==id}) else {throw PeerError.uncertainDelivery};value.drafts[i].status="unconfirmed"}}
    public func accepted(_ code:AssistantChannelCode,receipt:AssistantChannelReceipt) throws {
        guard let draft=pending(code) else {throw PeerError.uncertainDelivery}
        try receipt.validate(code,id:draft.id,text:draft.text)
        guard receipt.delivery=="accepted" else {throw PeerError.uncertainDelivery}
        try change {$0.receipts[draft.id]=Self.hash(Data(draft.text.utf8));$0.drafts.removeAll{$0.channelID==draft.channelID && $0.id==draft.id}}
    }
}
