import XCTest
@testable import WorkUpdatesCore

final class StateOrderTests:XCTestCase {
    func testOlderHTTPAndDuplicateRevisionCannotRestoreReviewedOrDoneState() throws {
        var order=StateOrder()
        let first=try snapshot(revision:1,reviewed:false,done:false)
        let newest=try snapshot(revision:3,reviewed:true,done:true)
        var visible=first
        if try order.accept(newest.stateVersion) {visible=newest}
        if try order.accept(first.stateVersion) {visible=first}
        XCTAssertTrue(visible.done.contains{$0.id=="task"})
        XCTAssertTrue(visible.done.first?.reviewed==true)
        XCTAssertFalse(try order.accept(newest.stateVersion))
    }
    func testNewHostRunNeedsANewConnectionBaselineEvenIfItsClockMovesBackward() throws {
        var order=StateOrder()
        let old=try snapshot(revision:80,reviewed:false,done:false)
        var restart=try snapshot(revision:1,reviewed:true,done:true)
        restart.servedAt=1;restart.stateVersion?.epoch="22222222-2222-4222-8222-222222222222"
        XCTAssertTrue(try order.accept(old.stateVersion))
        XCTAssertThrowsError(try order.accept(restart.stateVersion))
        order=StateOrder()
        XCTAssertTrue(try order.accept(restart.stateVersion))
        XCTAssertThrowsError(try order.accept(old.stateVersion))
    }
    func testMissingOrInvalidOrderingMetadataFailsClosed() throws {
        var order=StateOrder();XCTAssertThrowsError(try order.accept(nil))
        for revision in [Int64(0),-1,9_007_199_254_740_992] {
            XCTAssertThrowsError(try order.accept(QueueStateVersion(epoch:"11111111-1111-4111-8111-111111111111",revision:revision)))
        }
    }
    private func snapshot(revision:Int64,reviewed:Bool,done:Bool) throws -> QueueState {
        let card="""
        {"id":"task","taskKey":"task","title":"Synthetic task","label":"Ready to review","status":"ready","kind":"local","sources":[],"reviewed":\(reviewed),"done":\(done)}
        """
        let json="""
        {"protocolVersion":3,"stateVersion":{"epoch":"11111111-1111-4111-8111-111111111111","revision":\(revision)},"servedAt":100,"cards":\(done ? "[]" : "["+card+"]"),"done":\(done ? "["+card+"]" : "[]"),"approvals":[],"settings":{}}
        """
        return try QueueState.decode(Data(json.utf8))
    }
}
