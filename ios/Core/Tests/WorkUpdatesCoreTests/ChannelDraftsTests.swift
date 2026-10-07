import XCTest
@testable import WorkUpdatesCore

final class ChannelDraftsTests: XCTestCase {
    private var directory: URL!
    private var file: URL {directory.appendingPathComponent("drafts.json")}
    private let binding=DraftBinding(computerID:"paired-device",hostID:"authenticated-host",sourceID:"source",taskKey:"task",contextRevision:"context-1")
    override func setUpWithError() throws {
        directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    }
    override func tearDownWithError() throws {try FileManager.default.removeItem(at:directory)}
    private func receipt(_ id:String,sourceID:String="source",delivery:String="sent",turnID:String?="accepted-turn")->JSONValue {
        var result:[String:JSONValue]=["messageId":.string(id),"sourceId":.string(sourceID),"delivery":.string(delivery)]
        if let turnID {result["turnId"] = .string(turnID)}
        return .object(result)
    }
    func testDraftSurvivesRestartAndOtherOwnersCannotLoadIt() throws {
        let drafts=try ChannelDrafts(file:file)
        try drafts.save(binding,text:"Keep this unsent draft")
        let restarted=try ChannelDrafts(file:file)
        XCTAssertEqual(restarted.draft(binding)?.text,"Keep this unsent draft")
        for other in [DraftBinding(computerID:"another",hostID:binding.hostID,sourceID:binding.sourceID,taskKey:binding.taskKey,contextRevision:binding.contextRevision),
                      DraftBinding(computerID:binding.computerID,hostID:"another",sourceID:binding.sourceID,taskKey:binding.taskKey,contextRevision:binding.contextRevision),
                      DraftBinding(computerID:binding.computerID,hostID:binding.hostID,sourceID:"another",taskKey:binding.taskKey,contextRevision:binding.contextRevision)] {
            XCTAssertNil(restarted.draft(other))
        }
    }
    func testInterruptedAttemptRetainsIdentityAndBlocksNewContextSubmission() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Original message")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        try drafts.sending(binding,messageID:id)
        let restarted=try ChannelDrafts(file:file)
        XCTAssertEqual(restarted.draft(binding)?.status,"unconfirmed")
        XCTAssertEqual(restarted.draft(binding)?.messageID,id)
        XCTAssertEqual(restarted.draft(binding)?.text,"Original message")
        let newer=DraftBinding(computerID:binding.computerID,hostID:binding.hostID,sourceID:binding.sourceID,taskKey:binding.taskKey,contextRevision:"context-2")
        try restarted.save(newer,text:"Newer context message")
        XCTAssertThrowsError(try restarted.prepare(newer))
        XCTAssertThrowsError(try restarted.prepare(binding))
    }
    func testWrongSourceMissingTurnAndQueuedReceiptCannotClearDraft() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Keep me")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        for wrong in [receipt(id,sourceID:"another"),receipt(id,turnID:nil),receipt(id,delivery:"queued",turnID:nil),receipt(UUID().uuidString)] {
            XCTAssertThrowsError(try drafts.accepted(binding,messageID:id,result:wrong))
            XCTAssertEqual(drafts.draft(binding)?.text,"Keep me")
            XCTAssertTrue(drafts.receipts(computerID:binding.computerID).isEmpty)
        }
    }
    func testAcceptedReceiptClearsOnlyTheSubmittedRevisionAndDeduplicates() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"  Original  ")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        try drafts.accepted(binding,messageID:id,result:receipt(id))
        XCTAssertEqual(drafts.draft(binding)?.text,"")
        try drafts.save(binding,text:"A newer draft")
        try drafts.accepted(binding,messageID:id,result:receipt(id))
        XCTAssertEqual(drafts.draft(binding)?.text,"A newer draft")
        XCTAssertEqual(drafts.receipts(computerID:binding.computerID).count,1)
        XCTAssertEqual(try ChannelDrafts(file:file).draft(binding)?.text,"A newer draft")
        XCTAssertThrowsError(try drafts.failed(binding,messageID:id,notSent:false))
    }
    func testEditDuringDeliverySurvivesAcknowledgement() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Original")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        try drafts.sending(binding,messageID:id);try drafts.save(binding,text:"New text while pending")
        try drafts.accepted(binding,messageID:id,result:receipt(id))
        XCTAssertEqual(drafts.draft(binding)?.text,"New text while pending")
        XCTAssertEqual(drafts.draft(binding)?.status,"accepted")
    }
    func testOrderedOwnerRecoveryNeedsTheOriginalMessageAndSource() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Original")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID);try drafts.sending(binding,messageID:id)
        let source=try JSONDecoder().decode(ChatSource.self,from:JSONSerialization.data(withJSONObject:["id":"source","deliveryOutcomes":[["messageId":id,"sourceId":"source","status":"sent","turnId":"accepted-turn"]]]))
        try drafts.reconcile(computerID:"another",hostID:binding.hostID,sources:[source])
        try drafts.reconcile(computerID:binding.computerID,hostID:"another",sources:[source])
        XCTAssertEqual(drafts.draft(binding)?.text,"Original")
        try drafts.reconcile(computerID:binding.computerID,hostID:binding.hostID,sources:[source])
        XCTAssertEqual(drafts.draft(binding)?.text,"")
        XCTAssertEqual(drafts.receipts(computerID:binding.computerID).first?.turnID,"accepted-turn")
    }
    func testCancelledReceiptPreservesText() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Not delivered")
        let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        try drafts.accepted(binding,messageID:id,result:receipt(id,delivery:"cancelled",turnID:nil))
        XCTAssertEqual(drafts.draft(binding)?.text,"Not delivered")
        XCTAssertEqual(drafts.receipts(computerID:binding.computerID).first?.delivery,"cancelled")
    }
    func testFailedAtomicWriteAndReadbackHoldSendingWithoutDiscardingMemory() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Saved before failure")
        let original=try Data(contentsOf:file)
        let broken=try ChannelDrafts(file:file,write:{_,_ in throw PeerError.server("Synthetic write failure")})
        XCTAssertThrowsError(try broken.save(binding,text:"Unsaved change"))
        XCTAssertEqual(try Data(contentsOf:file),original)
        XCTAssertEqual(broken.draft(binding)?.text,"Saved before failure")
        XCTAssertThrowsError(try broken.prepare(binding))
        let corrupt=try ChannelDrafts(file:file,write:{_,target in try Data("{}".utf8).write(to:target,options:.atomic)})
        XCTAssertThrowsError(try corrupt.save(binding,text:"Not confirmed"))
        XCTAssertEqual(corrupt.draft(binding)?.text,"Saved before failure")
        XCTAssertThrowsError(try corrupt.prepare(binding))
    }
    func testFutureJournalAndExternalChangesArePreserved() throws {
        let future=Data("{\"version\":2,\"drafts\":[],\"receipts\":[]}".utf8)
        try future.write(to:file)
        XCTAssertThrowsError(try ChannelDrafts(file:file));XCTAssertEqual(try Data(contentsOf:file),future)
        try FileManager.default.removeItem(at:file)
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Saved")
        try future.write(to:file)
        XCTAssertThrowsError(try drafts.prepare(binding));XCTAssertEqual(try Data(contentsOf:file),future)
    }
}
