import XCTest
import CryptoKit
@testable import WorkUpdatesCore

final class AssistantChannelTests:XCTestCase {
    private var directory:URL!
    private var file:URL {directory.appendingPathComponent("assistant-drafts.json")}
    private let channel=UUID().uuidString.lowercased(),host=UUID().uuidString.lowercased()
    override func setUpWithError() throws {
        directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    }
    override func tearDownWithError() throws {try FileManager.default.removeItem(at:directory)}
    private func code(channel:String?=nil,pin:String=String(repeating:"a",count:64),address:String="127.0.0.1") throws -> String {
        let bytes=try JSONSerialization.data(withJSONObject:["host":address,"port":12345,"pin":pin,"token":String(repeating:"b",count:64),"version":1,"channelId":channel ?? self.channel,"hostId":host,"actorId":"human:fixture","until":2000000000000] as [String:Any])
        return "wua1:"+bytes.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
    }
    private func receipt(_ code:AssistantChannelCode,draft:AssistantDraft,delivery:String="accepted",text:String?=nil) -> AssistantChannelReceipt {
        let hash=SHA256.hash(data:Data((text ?? draft.text).utf8)).map{String(format:"%02x",$0)}.joined()
        return AssistantChannelReceipt(schema:1,channelId:code.channelID,hostId:code.hostID,epoch:UUID().uuidString,messageId:draft.id,delivery:delivery,completed:false,textHash:hash)
    }
    func testSeparateVersionAndPrivatePinnedEndpointRequired() throws {
        let value=try code(),parsed=try AssistantChannelCode(value)
        XCTAssertEqual(parsed.channelID,channel);XCTAssertEqual(parsed.hostID,host)
        XCTAssertThrowsError(try AssistantChannelCode("wu1:"+String(value.dropFirst(5))))
        XCTAssertThrowsError(try AssistantChannelCode(code(address:"8.8.8.8")))
        XCTAssertThrowsError(try AssistantChannelCode(code(pin:"no-pin")))
        XCTAssertThrowsError(try AssistantChannelCode(code(channel:"not-a-channel")))
    }
    func testInterruptedAttemptKeepsExactIdentityAndNeverBecomesANewSubmission() throws {
        let code=try AssistantChannelCode(code()),store=try AssistantDrafts(file:file)
        let original=try store.prepare(code,text:"Keep this uncertain question")
        let restarted=try AssistantDrafts(file:file),pending=try XCTUnwrap(restarted.pending(code))
        XCTAssertEqual(pending.id,original.id);XCTAssertEqual(pending.text,original.text);XCTAssertEqual(pending.status,"unconfirmed")
        XCTAssertThrowsError(try restarted.prepare(code,text:"Another message"))
        XCTAssertThrowsError(try restarted.accepted(code,receipt:receipt(code,draft:pending,delivery:"unknown")))
        XCTAssertEqual(restarted.pending(code)?.id,original.id)
    }
    func testWrongReceiverOrTextCannotClearPendingAndAcceptanceKeepsOtherChannels() throws {
        let one=try AssistantChannelCode(code()),two=try AssistantChannelCode(code(channel:UUID().uuidString.lowercased()))
        let store=try AssistantDrafts(file:file),a=try store.prepare(one,text:"Private question one"),b=try store.prepare(two,text:"Keep other channel")
        XCTAssertThrowsError(try store.accepted(one,receipt:receipt(two,draft:a)))
        XCTAssertThrowsError(try store.accepted(one,receipt:receipt(one,draft:a,text:"Different text")))
        try store.accepted(one,receipt:receipt(one,draft:a))
        XCTAssertNil(store.pending(one));XCTAssertEqual(store.pending(two)?.id,b.id)
        let restarted=try AssistantDrafts(file:file);XCTAssertNil(restarted.pending(one));XCTAssertEqual(restarted.pending(two)?.text,b.text)
        XCTAssertFalse(String(decoding:try Data(contentsOf:file),as:UTF8.self).contains(a.text))
    }
    func testFutureReplacedOrRedirectedJournalPreservesOriginalBytes() throws {
        let code=try AssistantChannelCode(code()),store=try AssistantDrafts(file:file),draft=try store.prepare(code,text:"Preserve this question")
        let bytes=try Data(contentsOf:file),target=directory.appendingPathComponent("other.json")
        try bytes.write(to:target);try FileManager.default.removeItem(at:file)
        try FileManager.default.createSymbolicLink(at:file,withDestinationURL:target)
        XCTAssertThrowsError(try store.uncertain(code,id:draft.id));XCTAssertEqual(try Data(contentsOf:target),bytes)
        XCTAssertThrowsError(try AssistantDrafts(file:file))
        try FileManager.default.removeItem(at:file)
        let future=Data("{\"version\":99,\"drafts\":[],\"receipts\":{}}".utf8);try future.write(to:file)
        XCTAssertThrowsError(try AssistantDrafts(file:file));XCTAssertEqual(try Data(contentsOf:file),future)
    }
    func testStateSeparatesAnswerCompletionFromAcceptanceAndRequiresExactAudience() throws {
        let code=try AssistantChannelCode(code())
        var object:[String:Any]=["schema":1,"version":1,"channelId":code.channelID,"hostId":code.hostID,"actorId":code.actorID,"epoch":UUID().uuidString,"until":code.until,"responding":false,"error":false,"messages":[],"stateVersion":["epoch":UUID().uuidString,"revision":1],"capabilities":["history":true,"questions":true,"taskActions":false,"attachments":false,"sharedAudience":false]]
        func state() throws -> AssistantChannelState {try JSONDecoder().decode(AssistantChannelState.self,from:JSONSerialization.data(withJSONObject:object))}
        try state().validate(code)
        object["channelId"]=UUID().uuidString;XCTAssertThrowsError(try state().validate(code))
        object["channelId"]=code.channelID;object["capabilities"]=["history":true,"questions":true,"taskActions":true,"attachments":false,"sharedAudience":false]
        XCTAssertThrowsError(try state().validate(code))
    }
    func testRealPinnedAssistantTLSAndReceiverReceiptWhenFixtureAvailable() async throws {
        let location=ProcessInfo.processInfo.environment["WU_TEST_CODE_FILE"] ?? "/tmp/work-updates-ios-pairing-code"
        guard let value=try? String(contentsOfFile:location+".assistant",encoding:.utf8) else {throw XCTSkip("Owned assistant TLS fixture is not running.")}
        let client=try AssistantChannelClient(code:value);defer{client.close()}
        let before=try await client.state(),id=UUID().uuidString.lowercased(),text="Swift private assistant question"
        XCTAssertFalse(before.capabilities["taskActions"] ?? true)
        let accepted=try await client.ask(id:id,text:text,epoch:before.epoch);XCTAssertEqual(accepted.delivery,"accepted");XCTAssertFalse(accepted.completed)
        let receipt=try await client.receipt(id:id,text:text);XCTAssertEqual(receipt.delivery,"accepted")
        _ = try await client.ask(id:id,text:text,epoch:before.epoch)
        var after=try await client.state()
        for _ in 0..<20 where !after.messages.contains(where:{$0.id==id && $0.status=="completed"}) {
            try await Task.sleep(nanoseconds:100_000_000);after=try await client.state()
        }
        XCTAssertEqual(after.messages.filter{$0.id==id}.count,1)
        XCTAssertEqual(after.messages.first{$0.id==id}?.answer,"Synthetic private answer: "+text)
        // Changing only the pin must fail before the bearer token can authenticate.
        var encoded=String(value.dropFirst(5)).replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
        encoded += String(repeating:"=",count:(4-encoded.count%4)%4)
        var envelope=try JSONSerialization.jsonObject(with:XCTUnwrap(Data(base64Encoded:encoded))) as! [String:Any]
        envelope["pin"]=String(repeating:"0",count:64)
        let wrong="wua1:"+(try JSONSerialization.data(withJSONObject:envelope)).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
        let rejected=try AssistantChannelClient(code:wrong);defer{rejected.close()}
        do {_ = try await rejected.state();XCTFail("Wrong pin must be rejected")}catch{}
    }
}
