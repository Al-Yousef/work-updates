import Foundation
import SwiftUI
import WorkUpdatesCore

struct DisplayCard: Identifiable {
    let computerID: String
    let task: TaskCard
    var id: String {computerID + ":" + task.taskKey}
}
struct LinkState {
    var online=false
    var lastSeen:Date?
    var message="Connecting…"
}
@MainActor final class WorkStore: ObservableObject {
    @Published var computers:[PairedComputer]=[]
    @Published var states:[String:QueueState]=[:]
    @Published var links:[String:LinkState]=[:]
    @Published var busy:Set<String>=[]
    @Published var error:String?
    @Published var lastUndoComputer:String?
    private var clients:[String:any PeerConnection]=[:]
    private var workers:[String:Task<Void,Never>]=[:]
    private var generations:[String:UUID]=[:]
    private var connections:[String:UUID]=[:]
    private var orders:[String:StateOrder]=[:]
    private var expectedHosts:[String:String]=[:]
    private let clientFactory:(String) throws -> any PeerConnection
    private let persist:([PairedComputer]) throws -> Void
    private var active=false
    let demo:Bool
    private(set) var channelDrafts:ChannelDrafts?
    init(computers:[PairedComputer]?=nil,
         clientFactory:@escaping (String) throws -> any PeerConnection = {try PeerClient(code:$0)},
         persist:@escaping ([PairedComputer]) throws -> Void = {try PairingVault.save($0)},
         channelDrafts:ChannelDrafts?=nil) {
        self.clientFactory=clientFactory;self.persist=persist
        demo=ProcessInfo.processInfo.arguments.contains("--demo")
        if demo {loadDemo();return}
        do {
            if let channelDrafts {self.channelDrafts=channelDrafts}
            else {
                let directory=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
                self.channelDrafts=try ChannelDrafts(file:directory.appendingPathComponent("private-channel-drafts-v1.json"))
            }
        } catch {self.error="Phone draft storage needs recovery. "+error.localizedDescription}
        if let computers {self.computers=computers}
        else {do {self.computers=try PairingVault.load()} catch {self.error=error.localizedDescription}}
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--integration-test"),
           let code=ProcessInfo.processInfo.environment["WU_PAIRING_CODE"],!code.isEmpty {
            self.computers=[PairedComputer(name:"Test computer",code:code,id:"integration-desktop")]
        }
        #endif
    }
    var cards:[DisplayCard] {
        let result:[DisplayCard] = computers.flatMap {computer in
            (states[computer.id]?.cards ?? []).map{DisplayCard(computerID:computer.id,task:$0)}
        }
        return result.sorted {a,b in
            if a.task.priorityRank != b.task.priorityRank {
                return a.task.priorityRank < b.task.priorityRank
            }
            return (a.task.at ?? 0) > (b.task.at ?? 0)
        }
    }
    var done:[DisplayCard] {
        let result:[DisplayCard] = computers.flatMap{computer in
            (states[computer.id]?.done ?? []).map{DisplayCard(computerID:computer.id,task:$0)}
        }
        return result.sorted{($0.task.at ?? 0)>($1.task.at ?? 0)}
    }
    func current(_ selection:DisplayCard) -> DisplayCard? {
        (cards+done).first{$0.computerID==selection.computerID && $0.task.taskKey==selection.task.taskKey}
    }
    func name(_ id:String) -> String {computers.first{$0.id==id}?.name ?? "Computer"}
    func online(_ id:String) -> Bool {links[id]?.online == true}
    func approvals(_ card:DisplayCard) -> [Approval] {
        states[card.computerID]?.approvals.filter{$0.taskId==card.task.id} ?? []
    }
    var connectionText:String {
        if computers.isEmpty {return "Connect your computers to see their chats"}
        let connected=computers.filter{online($0.id)}.count
        if connected==computers.count {return computers.count==1 ? "Connected to " + name(computers[0].id) : "All computers connected"}
        return "\(connected) of \(computers.count) computers connected"
    }
    func setActive(_ value:Bool) {
        guard !demo,active != value else {return}
        active=value
        for computer in computers {
            if value {start(computer)} else {pause(computer.id)}
        }
    }
    private func pause(_ id:String) {
        generations[id]=UUID()
        connections.removeValue(forKey:id);orders.removeValue(forKey:id)
        workers.removeValue(forKey:id)?.cancel()
        clients.removeValue(forKey:id)?.close()
        links[id]=LinkState(online:false,lastSeen:links[id]?.lastSeen,message:"Reconnects when the app opens")
    }
    private func accept(_ state:QueueState,id:String) throws {
        if let expected=expectedHosts[id],let actual=state.host?.id,expected != actual {
            throw PeerError.server("This computer’s identity changed. Forget it and pair again.")
        }
        var order=orders[id] ?? StateOrder()
        guard try order.accept(state.stateVersion) else {return}
        orders[id]=order
        if let actual=state.host?.id {expectedHosts[id]=actual}
        if let hostID=state.host?.id {
            do {try channelDrafts?.reconcile(computerID:id,hostID:hostID,sources:(state.cards+state.done).flatMap{$0.sources})}
            catch {self.error="Phone delivery recovery is held. "+error.localizedDescription}
        }
        states[id]=state
        links[id]=LinkState(online:true,lastSeen:Date(),message:state.health?.ok == false ?
            "Chat watcher paused: " + (state.health?.message ?? "Check the computer") : "Connected")
    }
    private func start(_ computer:PairedComputer) {
        pause(computer.id)
        let generation=UUID();generations[computer.id]=generation
        links[computer.id]?.message="Connecting…"
        workers[computer.id]=Task { [weak self] in
            var attempt=0
            while !Task.isCancelled {
                guard let self,self.active,self.generations[computer.id]==generation else {return}
                let connection=UUID()
                do {
                    let client=try self.clientFactory(computer.code)
                    self.connections[computer.id]=connection;self.orders[computer.id]=StateOrder()
                    self.clients[computer.id]=client
                    let state=try await client.state()
                    guard self.isCurrent(computer.id,generation:generation,connection:connection),!Task.isCancelled else {client.close();return}
                    try self.accept(state,id:computer.id);attempt=0
                    try await client.events { [weak self] state in
                        try await MainActor.run {
                            guard let self,self.isCurrent(computer.id,generation:generation,connection:connection),self.active else {throw CancellationError()}
                            try self.accept(state,id:computer.id)
                        }
                    }
                } catch {
                    guard self.generations[computer.id]==generation,!Task.isCancelled else {return}
                    self.clients.removeValue(forKey:computer.id)?.close()
                    self.connections.removeValue(forKey:computer.id);self.orders.removeValue(forKey:computer.id)
                    self.links[computer.id]=LinkState(online:false,lastSeen:self.links[computer.id]?.lastSeen,message:error.localizedDescription)
                    if let failure=error as? PeerError,case .revoked=failure {return}
                }
                attempt=min(attempt+1,5)
                try? await Task.sleep(for:.seconds(min(30,pow(2,Double(attempt-1)))))
            }
        }
    }
    func add(code:String,name:String) async throws {
        let value=try PairingCode(code)
        guard computers.count<8 else {throw PeerError.server("You can pair up to eight computers.")}
        if computers.contains(where:{(try? PairingCode($0.code))?.host==value.host && (try? PairingCode($0.code))?.port==value.port}) {
            throw PeerError.server("This computer is already paired. Forget its old connection before pairing again.")
        }
        let client=try clientFactory(code)
        defer {client.close()}
        let state=try await client.state()
        let label=name.trimmingCharacters(in:.whitespacesAndNewlines)
        let computer=PairedComputer(name:label.isEmpty ? state.host?.name ?? "Computer" : String(label.prefix(60)),code:code)
        // Validate ordering support before saving credentials or adding the device.
        var order=StateOrder();_ = try order.accept(state.stateVersion)
        try persist(computers+[computer])
        computers.append(computer)
        try accept(state,id:computer.id)
        if active {start(computer)}
    }
    func forget(_ id:String) throws {
        let next=computers.filter{$0.id != id}
        if !demo {try persist(next)}
        pause(id);computers=next;states.removeValue(forKey:id);links.removeValue(forKey:id);expectedHosts.removeValue(forKey:id)
        if lastUndoComputer==id {lastUndoComputer=nil}
    }
    func reconnect() {if !demo && active {for computer in computers {start(computer)}}}
    var retainedDraftComputers:[String] {channelDrafts?.retainedComputerIDs ?? []}
    func previewDraftRemoval(_ computerID:String) throws -> PhoneDraftRemovalPreview {
        guard !demo,let channelDrafts else {throw PeerError.server("Phone draft retention controls are unavailable.")}
        return try channelDrafts.previewRemoval(computerID:computerID)
    }
    func removeDrafts(_ preview:PhoneDraftRemovalPreview) throws {
        guard !demo,let channelDrafts,!busy.contains(where:{$0.hasPrefix(preview.computerID+":")}) else {throw PeerError.server("A request for this computer is still running. Its drafts are preserved.")}
        _ = try channelDrafts.removePreview(preview.id)
        objectWillChange.send()
    }
    func channelBinding(_ card:DisplayCard,sourceID:String) throws -> DraftBinding {
        guard computers.contains(where:{$0.id==card.computerID}),let current=current(card),
              current.task.sources.contains(where:{$0.id==sourceID}),let host=states[card.computerID]?.host?.id,!host.isEmpty else {throw PeerError.server("The saved draft requires its original paired owner and source.")}
        guard current.task.contextRevision==card.task.contextRevision else {throw PeerError.server("This chat context changed. Open its latest update before sending.")}
        return DraftBinding(computerID:card.computerID,hostID:host,sourceID:sourceID,taskKey:current.task.taskKey,contextRevision:current.task.contextRevision)
    }
    func draftText(_ binding:DraftBinding) throws -> String {
        if demo {return ""}
        guard let channelDrafts else {throw PeerError.server("Phone draft storage is unavailable. Sending is held.")}
        return channelDrafts.draft(binding)?.text ?? ""
    }
    func saveDraft(_ binding:DraftBinding,text:String) throws {
        if demo {return}
        guard let channelDrafts else {throw PeerError.server("Phone draft storage is unavailable. Keep this draft before leaving the chat.")}
        try channelDrafts.save(binding,text:text)
    }
    func sendDraft(_ card:DisplayCard,sourceID:String) async throws -> JSONValue {
        guard !demo,online(card.computerID),states[card.computerID]?.peerContract?.receiptVersion==1,
              states[card.computerID]?.supports("send")==true else {throw PeerError.server("Reconnect the current receipt-capable owner before sending.")}
        guard let channelDrafts else {throw PeerError.server("Phone draft storage is unavailable. Sending is held.")}
        let binding=try channelBinding(card,sourceID:sourceID),intent=try channelDrafts.prepare(binding)
        guard let messageID=intent.messageID,let text=intent.submittedText else {throw PeerError.uncertainDelivery}
        try channelDrafts.sending(binding,messageID:messageID)
        var input:[String:JSONValue]=["id":.string(card.task.id),"taskKey":.string(binding.taskKey),"sourceId":.string(sourceID),"messageId":.string(messageID),"text":.string(text)]
        if let revision=binding.contextRevision {input["contextRevision"] = .string(revision)}
        do {
            let result=try await command("send",computerID:card.computerID,input:input,lock:card.task.id)
            try channelDrafts.accepted(binding,messageID:messageID,result:result)
            return result
        } catch {
            // An error after the persisted attempt cannot prove no delivery.
            if channelDrafts.draft(binding)?.status != "accepted" {try? channelDrafts.failed(binding,messageID:messageID,notSent:false)}
            throw error
        }
    }
    private func isCurrent(_ id:String,generation:UUID?,connection:UUID?) -> Bool {
        generation != nil && connection != nil && generations[id]==generation && connections[id]==connection && computers.contains{$0.id==id}
    }
    @discardableResult func command(_ method:String,computerID:String,input:[String:JSONValue],lock:String="queue") async throws -> JSONValue {
        let key=computerID+":"+lock
        guard !busy.contains(key) else {throw PeerError.server("This action is already being sent.")}
        guard online(computerID) else {throw PeerError.server(name(computerID)+" is offline. Reconnect before sending this action.")}
        guard states[computerID]?.supports(method) == true else {throw PeerError.server("This computer does not support that action. Update its app before retrying.")}
        busy.insert(key);defer{busy.remove(key)}
        if demo {throw PeerError.server("This preview uses sample chats. Pair a computer to send real actions.")}
        guard let client=clients[computerID] else {throw PeerError.unpaired}
        let generation=generations[computerID]
        let connection=connections[computerID]
        var boundInput=input
        if let state=states[computerID],state.peerContract != nil,let epoch=state.stateVersion?.epoch {
            boundInput["_peerHostEpoch"] = .string(epoch)
        }
        let result=try await client.command(method,input:boundInput)
        guard isCurrent(computerID,generation:generation,connection:connection) else {
            if ["send","queueMessage","cancelMessage"].contains(method) {throw PeerError.uncertainDelivery}
            return result
        }
        // A successful POST is never retried when the subsequent state fetch fails.
        do {
            let state=try await client.state()
            if isCurrent(computerID,generation:generation,connection:connection) {try accept(state,id:computerID)}
        } catch PeerError.hostRestarted {
            if isCurrent(computerID,generation:generation,connection:connection),let computer=computers.first(where:{$0.id==computerID}) {start(computer)}
        } catch { /* A newer stream can still supply current state. Never repeat the POST. */ }
        guard isCurrent(computerID,generation:generation,connection:connection) else {
            if ["send","queueMessage","cancelMessage"].contains(method) {throw PeerError.uncertainDelivery}
            return result
        }
        if ["action","group"].contains(method) {lastUndoComputer=computerID}
        if method=="undo" {lastUndoComputer=nil}
        return result
    }
    func action(_ selection:DisplayCard,_ action:String) async throws {
        guard let card=current(selection) else {throw PeerError.server("This task changed. Open its latest update.")}
        try await command("action",computerID:card.computerID,input:["id":.string(card.task.id),"taskKey":.string(card.task.taskKey),"action":.string(action)],lock:card.task.id)
    }
    private func loadDemo() {
        let data=Data(Self.sample.utf8)
        if let state=try? QueueState.decode(data) {
            let computer=PairedComputer(name:"Windows PC",code:"",id:"demo-pc")
            computers=[computer];states[computer.id]=state;links[computer.id]=LinkState(online:true,lastSeen:Date(),message:"Sample queue")
        }
    }
    private static let sample="""
    {"host":{"id":"sample-pc","name":"Windows PC","kind":"pc"},"cards":[
      {"id":"choice","taskKey":"choice-task","title":"Choose the compact layout","chatName":"Interface review","summary":"Both previews are ready. Need your choice between compact and expanded.","label":"Waiting on you","status":"needs","kind":"observed","sources":[{"id":"choice-chat","title":"Interface review","body":"Need your choice between compact and expanded.","lifecycle":"completed","contextLoaded":true,"device":{"kind":"pc"}}],"readyForReview":true,"at":1790960000},
      {"id":"launch","taskKey":"launch-task","title":"Review launch notes","chatName":"Launch planning","summary":"The release summary and review checklist are ready.","label":"Ready to review","status":"ready","kind":"observed","sources":[{"id":"launch-chat","title":"Launch planning","body":"The launch notes are ready.","lifecycle":"completed","device":{"kind":"pc"}}],"readyForReview":true,"urgent":true,"at":1790960010},
      {"id":"work","taskKey":"work-task","title":"Check installer behavior","chatName":"Desktop app","summary":"Checking whether preferences survive an upgrade.","label":"Working","status":"working","kind":"observed","sources":[{"id":"work-chat","title":"Desktop app","lifecycle":"working","device":{"kind":"pc"}}],"at":1790960020}],
    "done":[],"approvals":[],"settings":{"projects":[]},"health":{"ok":true},"undo":false}
    """
}
