import XCTest
@testable import WorkUpdatesCore

final class PeerContractTests:XCTestCase {
    private func state(_ contract:[String:Any]?) throws -> QueueState {
        var value:[String:Any]=["protocolVersion":3,"stateVersion":["epoch":"11111111-1111-4111-8111-111111111111","revision":1],"cards":[],"done":[],"approvals":[],"settings":[:]]
        if let contract {value["peerContract"]=contract}
        return try QueueState.decode(JSONSerialization.data(withJSONObject:value))
    }
    private var contract:[String:Any] {["schema":1,"version":2,"minimumVersion":1,"commands":["send","queueMessage","cancelMessage","details"],"receiptVersion":1,"attachments":false,"assistant":false,"orderedSnapshots":true,"sourceBoundMessages":true]}
    func testLegacyClientsCannotClaimQueuedMessagesOrAssistantParity() throws {
        let legacy=try state(nil)
        XCTAssertTrue(legacy.supports("send"));XCTAssertFalse(legacy.supports("queueMessage"));XCTAssertFalse(legacy.supports("assistantAsk"))
        let current=try state(contract);XCTAssertTrue(current.supports("queueMessage"));XCTAssertFalse(current.supports("attachImages"))
    }
    func testFutureAndWidenedCapabilitiesAreRejected() throws {
        let patches:[[String:Any]] = [["version":3],["assistant":true],["attachments":true],["commands":["shell"]],["commands":["send","send"]],["receiptVersion":2]]
        for patch in patches {
            var value=contract;value.merge(patch){_,new in new};XCTAssertThrowsError(try state(value))
        }
    }
    func testHTTPReceiptNeedsExactMessageSourceAndActualAcceptance() throws {
        let correct:JSONValue = .object(["messageId":.string("message"),"sourceId":.string("source"),"delivery":.string("sent"),"turnId":.string("accepted-turn")])
        let receipt=try DeliveryReceipt.decode(correct,messageID:"message",sourceID:"source");XCTAssertEqual(receipt.turnID,"accepted-turn")
        XCTAssertThrowsError(try DeliveryReceipt.decode(correct,messageID:"another",sourceID:"source"))
        XCTAssertThrowsError(try DeliveryReceipt.decode(correct,messageID:"message",sourceID:"another"))
        let missingTurn:JSONValue = .object(["messageId":.string("message"),"sourceId":.string("source"),"delivery":.string("sent")])
        XCTAssertThrowsError(try DeliveryReceipt.decode(missingTurn,messageID:"message",sourceID:"source"))
        let queued:JSONValue = .object(["messageId":.string("message"),"sourceId":.string("source"),"delivery":.string("queued")])
        XCTAssertEqual(try DeliveryReceipt.decode(queued,messageID:"message",sourceID:"source").delivery,"queued")
    }
}
