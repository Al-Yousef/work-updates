import XCTest
@testable import WorkUpdatesCore
final class CoreTests:XCTestCase {
    private func code(host:String="100.101.102.103",port:Int=12345,pin:String=String(repeating:"a",count:64),token:String=String(repeating:"b",count:64)) throws -> String {
        let data=try JSONSerialization.data(withJSONObject:["host":host,"port":port,"pin":pin,"token":token])
        return "wu1:"+data.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
    }
    func testPairingUsesTheExistingDesktopCode() throws {
        let value=try PairingCode(code());XCTAssertEqual(value.host,"100.101.102.103");XCTAssertEqual(value.port,12345)
        XCTAssertEqual(value.baseURL.absoluteString,"https://100.101.102.103:12345")
    }
    func testPublicAddressesAndMalformedCodesAreRejected() throws {
        for host in ["8.8.8.8","0.0.0.0","169.254.1.1","localhost","::1","010.1.2.3","10.1.2.3/path","10.1.2.999"] {
            XCTAssertThrowsError(try PairingCode(code(host:host)))
        }
        XCTAssertThrowsError(try PairingCode(code(port:0)))
        XCTAssertThrowsError(try PairingCode(code(pin:"no-pin")))
        XCTAssertThrowsError(try PairingCode("wu1:broken"))
    }
    func testPrivateNetworksAcceptedIncludingOverlayAddresses() {
        for host in ["10.1.2.3","127.0.0.1","192.168.2.3","172.16.1.2","172.31.1.2","100.64.1.2","100.127.1.2"] {XCTAssertTrue(PairingCode.privateAddress(host))}
        XCTAssertFalse(PairingCode.privateAddress("100.128.1.2"))
        XCTAssertFalse(PairingCode.privateAddress("172.32.1.2"))
    }
    func testQueueKeepsChatAndTaskSeparateAndPrioritizesWaitingOnYou() throws {
        let state=try QueueState.decode(Data(Self.snapshot.utf8))
        let card=state.cards[0];XCTAssertEqual(card.chatName,"Source chat");XCTAssertEqual(card.title,"Current task")
        XCTAssertEqual(card.priorityRank,0);XCTAssertTrue(card.canComplete)
        var working=card;working.status="working";XCTAssertFalse(working.canComplete)
        var approval=card;approval.readyForReview=false;XCTAssertFalse(approval.canComplete)
    }
    func testJSONCommandsRoundTripQuestionsAndPermissions() throws {
        let input=JSONValue.object(["method":.string("respond"),"input":.object(["id":.string("17"),"answers":.object(["choice":.string("Compact")])])])
        let decoded=try JSONDecoder().decode(JSONValue.self,from:JSONEncoder().encode(input))
        XCTAssertEqual(decoded.object?["input"]?.object?["answers"]?.object?["choice"]?.string,"Compact")
    }
    func testInvalidAndOversizedQueuesAreRejected() {
        XCTAssertThrowsError(try QueueState.decode(Data("{}".utf8)))
        XCTAssertThrowsError(try QueueState.decode(Data(count:16_000_001)))
    }
    func testRealPrivateHTTPSFixtureWhenAvailable() async throws {
        let file=ProcessInfo.processInfo.environment["WU_TEST_CODE_FILE"] ?? "/tmp/work-updates-ios-pairing-code"
        guard let value=try? String(contentsOfFile:file,encoding:.utf8) else {throw XCTSkip("Private synthetic TLS fixture is not running.")}
        let client=try PeerClient(code:value);defer{client.close()}
        let state=try await client.state();XCTAssertEqual(state.protocolVersion,2);XCTAssertFalse(state.cards.isEmpty)
        let task=try await client.command("create",input:["title":.string("Swift protocol sample"),"prompt":.string("Synthetic fixture only.")])
        XCTAssertNotNil(task.object?["id"]?.string)
        let pairing=try PairingCode(value)
        let data=try JSONEncoder().encode(pairing)
        var object=try JSONSerialization.jsonObject(with:data) as! [String:Any];object["pin"]=String(repeating:"0",count:64)
        let wrong="wu1:"+(try JSONSerialization.data(withJSONObject:object)).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
        let rejected=try PeerClient(code:wrong);defer{rejected.close()}
        do {_ = try await rejected.state();XCTFail("A different certificate pin must be rejected")}catch{}
    }
    private static let snapshot="""
    {"protocolVersion":2,"host":{"id":"sample","name":"Windows PC","kind":"pc"},"cards":[{"id":"task","taskKey":"task-key","title":"Current task","chatName":"Source chat","label":"Waiting on you","status":"needs","kind":"observed","sources":[{"id":"source","title":"Source chat","body":"Need your choice.","lifecycle":"completed"}],"readyForReview":true}],"done":[],"approvals":[],"settings":{"projects":[]},"health":{"ok":true}}
    """
}
