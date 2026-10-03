import SwiftUI
import WorkUpdatesCore
struct ComposerView:View {
    @EnvironmentObject private var store:WorkStore
    @Environment(\.dismiss) private var dismiss
    var onQueued:(Bool)->Void = {_ in}
    @State private var computerID=""
    @State private var title=""
    @State private var prompt=""
    @State private var workspace=""
    @State private var saving=false
    private var valid:Bool {!saving && store.online(computerID) && !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && !prompt.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty}
    var body:some View {
        NavigationStack {
            Form {
                Section("Run on") {
                    Picker("Computer",selection:$computerID){ForEach(store.computers){c in Text(c.name+(store.online(c.id) ? "" : " · offline")).tag(c.id)}}
                        .onChange(of:computerID){_,_ in workspace=""}
                    Picker("Workspace",selection:$workspace) {
                        Text("Dedicated task folder").tag("")
                        ForEach(store.states[computerID]?.settings.projects ?? [],id:\.self){folder in Text(folder).tag(folder)}
                    }
                }
                Section("What needs doing?") {
                    TextField("Task title",text:$title).accessibilityIdentifier("task-title")
                    TextEditor(text:$prompt).frame(minHeight:140).accessibilityLabel("Task prompt").accessibilityIdentifier("task-prompt")
                    Text("File changes stay in the selected workspace. Codex asks before actions needing approval.").font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button(saving ? "Saving…" : "Queue task"){save(start:false)}.frame(minHeight:44).disabled(!valid).accessibilityIdentifier("queue-task")
                    Button("Queue & start chat"){save(start:true)}.frame(minHeight:44).disabled(!valid).accessibilityIdentifier("queue-start-task")
                }
            }.navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
                .workErrorAlert(store)
                .toolbar{ToolbarItem(placement:.topBarTrailing){Button("Cancel"){dismiss()}.disabled(saving)}}
                .onAppear{computerID=store.computers.first(where:{store.online($0.id)})?.id ?? store.computers.first?.id ?? ""}
        }
    }
    private func save(start:Bool) {
        guard valid else{return};saving=true
        Task {do {
            let result=try await store.command("create",computerID:computerID,input:["title":.string(String(title.prefix(100))),"prompt":.string(String(prompt.prefix(12000))),"cwd":.string(workspace)],lock:"create")
            onQueued(start);dismiss()
            if start {
                guard let id=result.object?["id"]?.string else {throw PeerError.server("The task was queued. Check that computer before starting it.")}
                try await store.command("start",computerID:computerID,input:["id":.string(id)],lock:id)
            }
        } catch {store.error=error.localizedDescription};saving=false}
    }
}
