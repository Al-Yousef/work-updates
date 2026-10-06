import XCTest
import WorkUpdatesCore
@testable import WorkUpdates

final class WorkStoreTests:XCTestCase {
    private let computer=PairedComputer(name:"Synthetic PC",code:"synthetic-test",id:"test-computer")
    private func snapshot(revision:Int64,epoch:String="11111111-1111-4111-8111-111111111111",
                          text:String="Old reply",reviewed:Bool=false,done:Bool=false) throws -> QueueState {
        let json: [String:Any]=[
            "protocolVersion":3,"host":["id":"33333333-3333-4333-8333-333333333333"],
            "stateVersion":["epoch":epoch,"revision":revision],"servedAt":100,
            "cards":done ? [] : [["id":"task","taskKey":"task","title":"Synthetic task","label":"Ready to review","status":"ready","kind":"local","sources":[["id":"source","body":text]],"reviewed":reviewed]],
            "done":done ? [["id":"task","taskKey":"task","title":"Synthetic task","label":"Done","status":"done","kind":"local","sources":[["id":"source","body":text]],"done":true,"reviewed":reviewed]] : [],
            "approvals":[],"settings":[:],"undo":true]
        return try QueueState.decode(JSONSerialization.data(withJSONObject:json))
    }
    @MainActor private func waitUntil(_ condition:()->Bool) async throws {
        for _ in 0..<300 {
            if condition() {return}
            try await Task.sleep(for:.milliseconds(10))
        }
        throw PeerError.server("Synthetic regression test timed out.")
    }
    @MainActor func testDelayedHTTPRefreshCannotRestoreDoneOrOlderChatText() async throws {
        let first=try snapshot(revision:1),peer=ControlledPeer(first)
        let store=WorkStore(computers:[computer],clientFactory:{_ in peer},persist:{_ in})
        defer {store.setActive(false)}
        store.setActive(true);try await waitUntil{store.online(self.computer.id) && peer.streamReady}
        let action=Task{try await store.command("action",computerID:computer.id,input:["id":.string("task"),"action":.string("reviewed")])}
        try await waitUntil{peer.pendingCommand};peer.completeCommand(.null)
        try await waitUntil{peer.pendingRead}
        let newest=try snapshot(revision:3,text:"Latest reply",reviewed:true,done:true)
        try await peer.emit(newest)
        peer.completeRead(try snapshot(revision:2))
        _ = try await action.value
        XCTAssertTrue(store.cards.isEmpty);XCTAssertEqual(store.done.first?.task.sources.first?.body,"Latest reply")
        XCTAssertEqual(peer.commandCount,1)
    }
    @MainActor func testSuccessfulCommandAfterForgetCannotRestoreUndoOwnership() async throws {
        let peer=ControlledPeer(try snapshot(revision:1))
        let store=WorkStore(computers:[computer],clientFactory:{_ in peer},persist:{_ in})
        store.setActive(true);try await waitUntil{store.online(self.computer.id) && peer.streamReady}
        let action=Task{try await store.command("action",computerID:computer.id,input:["id":.string("task"),"action":.string("reviewed")])}
        try await waitUntil{peer.pendingCommand};try store.forget(computer.id)
        peer.completeCommand(.null);_ = try await action.value
        XCTAssertNil(store.lastUndoComputer);XCTAssertTrue(store.states.isEmpty);XCTAssertTrue(store.computers.isEmpty)
        XCTAssertEqual(peer.readCount,1,"No refresh is made on the forgotten connection")
    }
    @MainActor func testCommandAfterExplicitReconnectCannotRestoreUndoOrOlderState() async throws {
        try await checkReplacedConnection(implicit:false)
    }
    @MainActor func testCommandAfterStreamReconnectCannotRestoreUndoOrOlderState() async throws {
        try await checkReplacedConnection(implicit:true)
    }
    @MainActor private func checkReplacedConnection(implicit:Bool) async throws {
        let old=ControlledPeer(try snapshot(revision:80))
        var restarted=try snapshot(revision:1,epoch:"22222222-2222-4222-8222-222222222222",text:"After restart")
        restarted.servedAt=1
        let next=ControlledPeer(restarted)
        var peers=[old,next]
        let store=WorkStore(computers:[computer],clientFactory:{_ in peers.removeFirst()},persist:{_ in})
        defer {store.setActive(false)}
        store.setActive(true);try await waitUntil{store.online(self.computer.id) && old.streamReady}
        let action=Task{try await store.command("action",computerID:computer.id,input:["id":.string("task"),"action":.string("reviewed")])}
        try await waitUntil{old.pendingCommand}
        if implicit {old.finishStream(PeerError.server("Synthetic disconnect"))} else {store.reconnect()}
        try await waitUntil{next.streamReady && store.cards.first?.task.sources.first?.body=="After restart"}
        old.completeCommand(.null);_ = try await action.value
        XCTAssertNil(store.lastUndoComputer);XCTAssertEqual(store.cards.first?.task.sources.first?.body,"After restart")
        XCTAssertEqual(old.readCount,1);XCTAssertEqual(old.commandCount,1);XCTAssertEqual(next.commandCount,0)
    }
    @MainActor func testUncertainReplyIsNeverAutomaticallyResent() async throws {
        let peer=ControlledPeer(try snapshot(revision:1));peer.commandFailure = .uncertainDelivery
        let store=WorkStore(computers:[computer],clientFactory:{_ in peer},persist:{_ in})
        defer {store.setActive(false)}
        store.setActive(true);try await waitUntil{store.online(self.computer.id) && peer.streamReady}
        do {
            _ = try await store.command("send",computerID:computer.id,input:["id":.string("task"),"text":.string("Synthetic reply")])
            XCTFail("Uncertain delivery must be surfaced")
        } catch PeerError.uncertainDelivery {}
        try await peer.emit(snapshot(revision:2,text:"Fresh recorded context"))
        XCTAssertEqual(peer.commandCount,1);XCTAssertEqual(peer.readCount,1)
        XCTAssertEqual(store.cards.first?.task.sources.first?.body,"Fresh recorded context")
    }
}

// This deliberately permits a late command acknowledgement after close: transport
// cancellation is not permission for the store to accept a stale completion.
private final class ControlledPeer:PeerConnection,@unchecked Sendable {
    private let initial:QueueState
    private let lock=NSLock()
    private var reads=0,commands=0
    private var read:CheckedContinuation<QueueState,Error>?
    private var reply:CheckedContinuation<JSONValue,Error>?
    private var stream:CheckedContinuation<Void,Error>?
    private var receive:(@Sendable (QueueState) async throws -> Void)?
    var commandFailure:PeerError?
    init(_ state:QueueState) {initial=state}
    private func locked<T>(_ body:()->T)->T {lock.lock();defer{lock.unlock()};return body()}
    var commandCount:Int {locked{commands}}
    var readCount:Int {locked{reads}}
    var streamReady:Bool {locked{receive != nil}}
    var pendingCommand:Bool {locked{reply != nil}}
    var pendingRead:Bool {locked{read != nil}}
    func state() async throws -> QueueState {
        let first=locked{reads+=1;return reads==1}
        if first {return initial}
        return try await withCheckedThrowingContinuation{continuation in locked{read=continuation}}
    }
    func command(_ method:String,input:[String:JSONValue]) async throws -> JSONValue {
        locked{commands+=1}
        if let commandFailure {throw commandFailure}
        return try await withCheckedThrowingContinuation{continuation in locked{reply=continuation}}
    }
    func events(_ receive:@escaping @Sendable (QueueState) async throws -> Void) async throws {
        try await withCheckedThrowingContinuation{continuation in locked{self.receive=receive;stream=continuation}}
    }
    func emit(_ state:QueueState) async throws {if let receive=locked({self.receive}) {try await receive(state)}}
    func completeRead(_ state:QueueState) {
        let continuation=locked{let value=read;read=nil;return value};continuation?.resume(returning:state)
    }
    func completeCommand(_ value:JSONValue) {
        let continuation=locked{let value=reply;reply=nil;return value};continuation?.resume(returning:value)
    }
    func finishStream(_ error:Error) {
        let continuation=locked{let value=stream;stream=nil;receive=nil;return value};continuation?.resume(throwing:error)
    }
    func close() {
        finishStream(CancellationError())
        let continuation=locked{let value=read;read=nil;return value};continuation?.resume(throwing:CancellationError())
    }
}
