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
    func testScopedRemovalKeepsReceiptsOtherComputersAndAcceptedDeliveryAfterRestart() throws {
        let drafts=try ChannelDrafts(file:file),other=DraftBinding(computerID:"another-computer",hostID:"other-host",sourceID:"other-source",taskKey:"other-task",contextRevision:nil)
        try drafts.save(binding,text:"Private submitted text");let id=try XCTUnwrap(drafts.prepare(binding).messageID)
        try drafts.sending(binding,messageID:id);try drafts.accepted(binding,messageID:id,result:receipt(id))
        try drafts.save(other,text:"Keep the other computer draft")
        let preview=try drafts.previewRemoval(computerID:binding.computerID)
        XCTAssertEqual(preview.draftCount,1);XCTAssertEqual(preview.uncertainCount,0);XCTAssertEqual(preview.retainedReceipts,1)
        XCTAssertEqual(preview.retainedTextBytes,"Private submitted text".utf8.count)
        XCTAssertEqual(try drafts.removePreview(preview.id),1)
        XCTAssertThrowsError(try drafts.removePreview(preview.id))
        let restarted=try ChannelDrafts(file:file)
        XCTAssertNil(restarted.draft(binding));XCTAssertEqual(restarted.draft(other)?.text,"Keep the other computer draft")
        XCTAssertEqual(restarted.receipts(computerID:binding.computerID).first?.messageID,id)
        XCTAssertThrowsError(try restarted.accepted(binding,messageID:id,result:receipt(id)))
        XCTAssertFalse(String(decoding:try Data(contentsOf:file),as:UTF8.self).contains("Private submitted text"))
    }
    func testRemovalHoldsChangedExpiredAndUncertainDraftsAndRestartDropsPreview() throws {
        var clock=1000.0;let drafts=try ChannelDrafts(file:file,now:{clock})
        try drafts.save(binding,text:"Unsent original")
        let stale=try drafts.previewRemoval(computerID:binding.computerID);try drafts.save(binding,text:"Changed draft")
        XCTAssertThrowsError(try drafts.removePreview(stale.id));XCTAssertEqual(drafts.draft(binding)?.text,"Changed draft")
        let expired=try drafts.previewRemoval(computerID:binding.computerID);clock+=601
        XCTAssertThrowsError(try drafts.removePreview(expired.id))
        let prepared=try drafts.prepare(binding),id=try XCTUnwrap(prepared.messageID)
        let uncertain=try drafts.previewRemoval(computerID:binding.computerID);XCTAssertEqual(uncertain.uncertainCount,1)
        XCTAssertThrowsError(try drafts.removePreview(uncertain.id));try drafts.failed(binding,messageID:id,notSent:false)
        let restarted=try ChannelDrafts(file:file,now:{clock});XCTAssertThrowsError(try restarted.removePreview(uncertain.id))
        XCTAssertEqual(restarted.draft(binding)?.text,"Changed draft");XCTAssertEqual(restarted.draft(binding)?.status,"unconfirmed")
    }
    func testRemovalRefusesExternalChangesAndRedirectedFilesWithoutErasingThem() throws {
        let drafts=try ChannelDrafts(file:file);try drafts.save(binding,text:"Preserve this draft")
        let preview=try drafts.previewRemoval(computerID:binding.computerID),original=try Data(contentsOf:file)
        let target=directory.appendingPathComponent("other.json");try original.write(to:target)
        try FileManager.default.removeItem(at:file);try FileManager.default.createSymbolicLink(at:file,withDestinationURL:target)
        XCTAssertThrowsError(try drafts.removePreview(preview.id));XCTAssertEqual(try Data(contentsOf:target),original)
        try FileManager.default.removeItem(at:file);try original.write(to:file)
        let newDrafts=try ChannelDrafts(file:file),changed=try newDrafts.previewRemoval(computerID:binding.computerID)
        let replacement=Data("{\"version\":999,\"drafts\":[],\"receipts\":[]}".utf8);try replacement.write(to:file)
        XCTAssertThrowsError(try newDrafts.removePreview(changed.id));XCTAssertEqual(try Data(contentsOf:file),replacement)
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
