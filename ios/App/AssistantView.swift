import SwiftUI
import WorkUpdatesCore

@MainActor private final class PhoneAssistant:ObservableObject {
    @Published var state:AssistantChannelState?
    @Published var message="Connect with a separate private assistant code."
    @Published var pending:AssistantDraft?
    @Published var busy=false
    private var client:AssistantChannelClient?
    private var journal:AssistantDrafts?
    private var order=StateOrder()
    private var generation=UUID()
    private let loadCredential:() throws -> String?
    private let saveCredential:(String?) throws -> Void
    init(loadCredential:@escaping () throws -> String?={try AssistantChannelVault.load()},
         saveCredential:@escaping (String?) throws -> Void={try AssistantChannelVault.save($0)}) {
        self.loadCredential=loadCredential;self.saveCredential=saveCredential
    }
    func connect(_ code:String?=nil) async {
        stop();let current=generation
        var owned:AssistantChannelClient?
        do {
            let savedCode:String?
            if let code {savedCode=code} else {savedCode=try loadCredential()}
            guard let saved=savedCode else {return}
            let next=try AssistantChannelClient(code:saved);owned=next
            if code != nil {try saveCredential(saved)}
            let directory=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
            journal=try AssistantDrafts(file:directory.appendingPathComponent("private-assistant-drafts-v1.json"));client=next
            pending=journal?.pending(next.code)
            while !Task.isCancelled,generation==current {
                do {let snapshot=try await next.state();guard generation==current else {return}
                    if try order.accept(snapshot.stateVersion) {state=snapshot;message=snapshot.responding ? "Hyphen is answering":"Connected to your private assistant"}
                    if let draft=pending {let receipt=try await next.receipt(id:draft.id,text:draft.text)
                        guard generation==current else {return}
                        if receipt.delivery=="accepted" {try journal?.accepted(next.code,receipt:receipt);pending=journal?.pending(next.code);message="Message accepted. Its answer is tracked separately."}
                    }
                }catch PeerError.hostRestarted {order=StateOrder();state=nil;message="Computer restarted. Reading this channel again; no message was resent."}
                catch {next.close();guard generation==current else {return};state=nil;client=nil;message="Unavailable or revoked. Draft and receipt checks remain saved. "+error.localizedDescription;return}
                try await Task.sleep(nanoseconds:2_000_000_000)
            }
            next.close();if generation==current {client=nil;state=nil}
        }catch{owned?.close();if generation==current {message=error.localizedDescription;state=nil;client=nil}}
    }
    func send(_ text:String) async -> Bool {
        guard !busy,pending==nil,let client,let state,let journal else {return false}
        let current=generation
        busy=true;defer{busy=false}
        var draft:AssistantDraft?
        do {
            let prepared=try journal.prepare(client.code,text:text.trimmingCharacters(in:.whitespacesAndNewlines));draft=prepared;pending=prepared
            _ = try await client.ask(id:prepared.id,text:prepared.text,epoch:state.epoch)
            guard generation==current else {return false}
            let receipt=try await client.receipt(id:prepared.id,text:prepared.text)
            guard generation==current else {return false}
            try journal.accepted(client.code,receipt:receipt);pending=journal.pending(client.code);message="Message accepted. Waiting for its answer.";return true
        }catch{
            if let draft {try? journal.uncertain(client.code,id:draft.id)}
            if generation==current {pending=journal.pending(client.code);message="Acceptance is unconfirmed. This message will not be resent automatically."};return false
        }
    }
    func forget() {stop();do{try saveCredential(nil);state=nil;pending=nil;message="Phone credential forgotten. Revoke its grant on the computer. Saved receipt checks remain."}catch{message=error.localizedDescription}}
    func stop(){generation=UUID();client?.close();client=nil;state=nil;pending=nil;order=StateOrder()}
}
struct AssistantView:View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @StateObject private var assistant:PhoneAssistant
    @State private var code=""
    @State private var text=""
    @State private var session=UUID()
    private enum Field:Hashable {case question,code}
    @FocusState private var focusedField:Field?
    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--integration-test"),
           let code=ProcessInfo.processInfo.environment["WU_ASSISTANT_CODE"],!code.isEmpty {
            // Unsigned Simulator tests inject a disposable credential store.
            // Normal/release builds always use Keychain and hold its failures.
            let fixture=SyntheticAssistantCredential(code)
            _assistant=StateObject(wrappedValue:PhoneAssistant(loadCredential:{fixture.code},saveCredential:{fixture.code=$0}))
        } else {_assistant=StateObject(wrappedValue:PhoneAssistant())}
        #else
        _assistant=StateObject(wrappedValue:PhoneAssistant())
        #endif
    }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:16) {
                    Text(assistant.message).font(.footnote).accessibilityIdentifier("assistant-channel-status")
                    if let state=assistant.state {
                        Text(state.profile?.displayName ?? "Hyphen").font(.title2.bold())
                        Text("Private conversation for this client. Task context and pinned notes are shared by your grant. Existing desktop conversations and other channels are separate. Task actions are available on the desktop.").font(.caption).foregroundStyle(.secondary)
                        ForEach(state.messages) {message in
                            VStack(alignment:.leading,spacing:8) {
                                Text(message.text).font(.body.weight(.medium))
                                if !message.answer.isEmpty {Text(message.answer).textSelection(.enabled)}
                                Text(message.status=="thinking" ? "Answer pending":message.status=="failed" ? message.error:"Answer completed").font(.caption).foregroundStyle(.secondary)
                            }.padding().frame(maxWidth:.infinity,alignment:.leading).background(.thinMaterial,in:RoundedRectangle(cornerRadius:18))
                        }
                        if let pending=assistant.pending {Text("Saved message awaiting acceptance check: "+pending.text).font(.footnote).textSelection(.enabled)}
                        TextField("Ask your assistant",text:$text,axis:.vertical).lineLimit(3...8).textFieldStyle(.roundedBorder).focused($focusedField,equals:.question).accessibilityIdentifier("assistant-channel-input")
                        Button("Send question") {let submitted=text;Task{if await assistant.send(submitted),text==submitted {text="";focusedField=nil}}}.buttonStyle(.borderedProminent)
                            .disabled(assistant.busy || assistant.pending != nil || state.responding || text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("assistant-channel-send")
                    }
                    DisclosureGroup("Private device connection") {
                        Text("On your computer, use /channels open in the assistant. Create a grant for your own device, then paste its private code here.").font(.caption)
                        SecureField("Private assistant code",text:$code).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focusedField,equals:.code)
                        Button("Connect private assistant") {let value=code;code="";focusedField=nil;Task{await assistant.connect(value)}}.disabled(code.isEmpty)
                        Button("Reconnect saved channel") {session=UUID()}
                        Button("Forget phone credential",role:.destructive){assistant.forget()}
                    }
                }.padding()
            }.scrollDismissesKeyboard(.interactively).navigationTitle("Assistant").navigationBarTitleDisplayMode(.inline)
                .toolbar{
                    ToolbarItem(placement:.topBarTrailing){Button("Done"){dismiss()}}
                    ToolbarItemGroup(placement:.keyboard){Spacer();Button("Done typing"){focusedField=nil}}
                }
                .task(id:session){
                    let fixture=ProcessInfo.processInfo.arguments.contains("--integration-test") ? ProcessInfo.processInfo.environment["WU_ASSISTANT_CODE"] : nil
                    await assistant.connect(fixture)
                }
                .onDisappear{assistant.stop()}
                .onChange(of:phase){_,value in if value != .active {assistant.stop()}else{session=UUID()}}
        }
    }
}
#if DEBUG
@MainActor private final class SyntheticAssistantCredential {
    var code:String?
    init(_ code:String){self.code=code}
}
#endif
