import Foundation
import CryptoKit

public struct AssistantChannelCode: Sendable {
    public let pairing:PairingCode
    public let channelID:String
    public let hostID:String
    public let actorID:String
    public let until:Double
    private struct Envelope:Decodable {let host:String;let port:Int;let pin:String;let token:String;let version:Int;let channelId:String;let hostId:String;let actorId:String;let until:Double}
    public init(_ code:String) throws {
        let text=code.trimmingCharacters(in:.whitespacesAndNewlines)
        guard text.count<=2000,text.hasPrefix("wua1:") else {throw PeerError.invalidCode}
        var encoded=String(text.dropFirst(5)).replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
        encoded += String(repeating:"=",count:(4-encoded.count%4)%4)
        guard let bytes=Data(base64Encoded:encoded),let e=try? JSONDecoder().decode(Envelope.self,from:bytes),e.version==1,
              UUID(uuidString:e.channelId) != nil,UUID(uuidString:e.hostId) != nil,!e.actorId.isEmpty,e.actorId.count<=200,
              e.until.isFinite,e.until>0 else {throw PeerError.invalidCode}
        // The existing private-address, exact certificate and token validation is reused.
        pairing=try PairingCode("wu1:"+String(text.dropFirst(5)))
        channelID=e.channelId;hostID=e.hostId;actorID=e.actorId;until=e.until
    }
}
public struct AssistantChannelMessage:Codable,Identifiable,Sendable {
    public let id:String;public let text:String;public let answer:String;public let status:String;public let at:Double;public let error:String
}
public struct AssistantChannelState:Codable,Sendable {
    public let schema:Int;public let version:Int;public let channelId:String;public let hostId:String;public let actorId:String;public let epoch:String
    public let until:Double;public let profile:AssistantDisplayProfile?;public let responding:Bool;public let error:Bool
    public let messages:[AssistantChannelMessage];public let stateVersion:QueueStateVersion;public let capabilities:[String:Bool]
    public func validate(_ code:AssistantChannelCode) throws {
        guard schema==1,version==1,channelId==code.channelID,hostId==code.hostID,actorId==code.actorID,
              UUID(uuidString:epoch) != nil,until==code.until,capabilities==["history":true,"questions":true,"taskActions":false,"attachments":false,"sharedAudience":false],
              messages.count<=30,Set(messages.map{$0.id}).count==messages.count,
              messages.allSatisfy({UUID(uuidString:$0.id) != nil && $0.text.utf16.count<=4000 && $0.answer.utf16.count<=6000 && ["thinking","completed","failed"].contains($0.status) && $0.at.isFinite})
        else {throw PeerError.unsupportedState}
        var order=StateOrder();_ = try order.accept(stateVersion)
    }
}
public struct AssistantChannelReceipt:Codable,Sendable {
    public let schema:Int;public let channelId:String;public let hostId:String;public let epoch:String;public let messageId:String;public let delivery:String;public let completed:Bool
    public let textHash:String?
    public func validate(_ code:AssistantChannelCode,id:String,text:String?=nil) throws {
        guard schema==1,channelId==code.channelID,hostId==code.hostID,messageId==id,UUID(uuidString:epoch) != nil,
              completed==false,["accepted","unknown"].contains(delivery) else {throw PeerError.uncertainDelivery}
        if let text,delivery=="accepted" {guard textHash==SHA256.hash(data:Data(text.utf8)).map({String(format:"%02x",$0)}).joined() else {throw PeerError.uncertainDelivery}}
    }
}
public final class AssistantChannelClient:@unchecked Sendable {
    public let code:AssistantChannelCode
    private let session:URLSession
    private let delegate:PinnedDelegate
    public init(code:String) throws {
        self.code=try AssistantChannelCode(code);delegate=PinnedDelegate(self.code.pairing)
        let c=URLSessionConfiguration.ephemeral;c.urlCache=nil;c.httpCookieStorage=nil;c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest=20;c.timeoutIntervalForResource=30;c.tlsMinimumSupportedProtocolVersion = .TLSv12
        session=URLSession(configuration:c,delegate:delegate,delegateQueue:nil)
    }
    private func request(_ path:String,body:Data?=nil) async throws -> Data {
        var r=URLRequest(url:code.pairing.baseURL.appendingPathComponent(path));r.httpMethod=body==nil ? "GET":"POST";r.httpBody=body
        r.setValue("Bearer "+code.pairing.token,forHTTPHeaderField:"Authorization");r.setValue("application/json",forHTTPHeaderField:"Accept")
        if body != nil {r.setValue("application/json",forHTTPHeaderField:"Content-Type")}
        let (bytes,response)=try await session.bytes(for:r,delegate:delegate)
        guard let http=response as? HTTPURLResponse else {throw PeerError.unsupportedState}
        if http.statusCode==401 {throw PeerError.revoked}
        if (300...399).contains(http.statusCode) {throw PeerError.redirect}
        guard http.statusCode==200 else {throw PeerError.uncertainDelivery}
        var data=Data();for try await byte in bytes {try Task.checkCancellation();data.append(byte);if data.count>512000 {throw PeerError.responseTooLarge}}
        return data
    }
    public func state() async throws -> AssistantChannelState {
        let data=try await request("assistant/state"),state=try JSONDecoder().decode(AssistantChannelState.self,from:data)
        try state.validate(code);return state
    }
    public func ask(id:String,text:String,epoch:String) async throws -> AssistantChannelReceipt {
        guard UUID(uuidString:id) != nil,UUID(uuidString:epoch) != nil,!text.isEmpty,text.utf16.count<=4000 else {throw PeerError.uncertainDelivery}
        let body=try JSONEncoder().encode(JSONValue.object(["version":.number(1),"channelId":.string(code.channelID),"epoch":.string(epoch),
            "input":.object(["messageId":.string(id),"text":.string(text)])]))
        let data=try await request("assistant/ask",body:body),value=try JSONDecoder().decode(JSONValue.self,from:data).object
        guard case .bool(true)?=value?["ok"],let receipt=value?["value"] else {throw PeerError.uncertainDelivery}
        let decoded=try JSONDecoder().decode(AssistantChannelReceipt.self,from:JSONEncoder().encode(receipt));try decoded.validate(code,id:id)
        guard decoded.delivery=="accepted",decoded.epoch==epoch else {throw PeerError.uncertainDelivery};return decoded
    }
    public func receipt(id:String,text:String) async throws -> AssistantChannelReceipt {
        guard UUID(uuidString:id) != nil else {throw PeerError.uncertainDelivery}
        let data=try await request("assistant/receipt/"+id)
        let result=try JSONDecoder().decode(AssistantChannelReceipt.self,from:data);try result.validate(code,id:id,text:text);return result
    }
    public func close(){session.invalidateAndCancel()}
}
