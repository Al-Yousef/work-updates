import SwiftUI
import WorkUpdatesCore
import WorkUpdatesCore
struct DevicesView:View {
    @EnvironmentObject private var store:WorkStore
    @Environment(\.dismiss) private var dismiss
    @State private var code=""
    @State private var name=""
    @State private var connecting=false
    @State private var forget:PairedComputer?
    @State private var draftRemoval:PhoneDraftRemovalPreview?
    var body:some View {
        NavigationStack {
            Form {
                Section("Your computers") {
                    ForEach(store.computers) {computer in
                        VStack(alignment:.leading,spacing:6) {
                            Label(computer.name,systemImage:store.states[computer.id]?.host?.kind=="mac" ? "laptopcomputer" : "desktopcomputer").font(.headline)
                            Text(store.links[computer.id]?.message ?? "Connecting…").font(.subheadline).foregroundStyle(.secondary)
                            if let date=store.links[computer.id]?.lastSeen {Text("Last sync "+date.formatted(date:.omitted,time:.shortened)).font(.caption).foregroundStyle(.secondary)}
                            Button("Forget this connection",role:.destructive){forget=computer}.frame(minHeight:44)
                        }.padding(.vertical,6)
                    }
                    if store.computers.isEmpty {Text("No computers paired yet.").foregroundStyle(.secondary)}
                    Button("Reconnect computers"){store.reconnect()}.frame(minHeight:44).disabled(store.computers.isEmpty || store.demo)
                }
                Section {
                    TextField("Name, e.g. MacBook",text:$name).textContentType(.nickname)
                    TextField("Paste pairing code",text:$code,axis:.vertical).lineLimit(2...5).autocorrectionDisabled().textInputAutocapitalization(.never).privacySensitive().accessibilityIdentifier("pairing-code")
                    Button {
                        connecting=true
                        Task {do{try await store.add(code:code,name:name);code="";name=""}catch{store.error=error.localizedDescription};connecting=false}
                    } label:{HStack{Text(connecting ? "Connecting…" : "Connect computer");if connecting{ProgressView()}}.frame(minHeight:44)}
                        .disabled(connecting || code.isEmpty || store.demo).accessibilityIdentifier("connect-computer")
                } header:{Text("Add a computer")} footer:{Text("In Work Updates on the computer, open Settings → Your devices → Copy pairing code. Use its private overlay network address for access away from home. Keep pairing codes private.")}
                Section("Away from home") {
                    Text("Connect this iPhone and both computers to the same private Tailscale network. Use each computer’s 100.x address when pairing. The computers must stay awake with Work Updates running.")
                    Link("Tailscale device setup",destination:URL(string:"https://tailscale.com/docs/quickstart")!)
                }
                Section("Phone updates") {Text("Updates stream while this app is open and refresh when it returns to the foreground. Continuous background push is not enabled in this build.")}
                Section {
                    if store.retainedDraftComputers.isEmpty {Text("No saved phone drafts.").foregroundStyle(.secondary)}
                    ForEach(store.retainedDraftComputers,id:\.self) {computerID in
                        VStack(alignment:.leading,spacing:6) {
                            Text(store.name(computerID)).font(.headline)
                            Text("Computer ID: "+computerID).font(.caption).textSelection(.enabled)
                            Button("Preview draft removal") {do{draftRemoval=try store.previewDraftRemoval(computerID)}catch{store.error=error.localizedDescription}}
                                .frame(minHeight:44).accessibilityIdentifier("preview-phone-draft-removal")
                        }
                    }
                } header:{Text("Saved phone drafts")} footer:{Text("Drafts stay on this phone after a pairing is forgotten. Removal keeps delivery receipts and never deletes computer chats or reverses an accepted send.")}
            }.navigationTitle("Your devices").navigationBarTitleDisplayMode(.inline)
                .workErrorAlert(store)
                .toolbar{ToolbarItem(placement:.topBarTrailing){Button("Done"){dismiss()}}}
                .confirmationDialog("Forget this connection?",isPresented:Binding(get:{forget != nil},set:{if !$0{forget=nil}}),titleVisibility:.visible) {
                    Button("Forget computer",role:.destructive){if let computer=forget{do{try store.forget(computer.id)}catch{store.error=error.localizedDescription}};forget=nil}
                } message:{Text("This removes this iPhone’s saved pairing. Chats and tasks on the computer are preserved.")}
                .sheet(item:$draftRemoval) {preview in
                    NavigationStack {
                        Form {
                            Section("Affected phone data") {
                                Text(store.name(preview.computerID))
                                Text("Computer ID: "+preview.computerID).font(.caption).textSelection(.enabled)
                                Text("Saved drafts: \(preview.draftCount)")
                                Text("Retained text bytes: \(preview.retainedTextBytes)")
                                Text("Delivery receipts kept: \(preview.retainedReceipts)")
                                Text("Uncertain sends: \(preview.uncertainCount)")
                                Text("Preview expires after ten minutes; changes require a fresh preview.").font(.caption)
                            }
                            Section {
                                Button("Remove these phone drafts",role:.destructive) {
                                    do{try store.removeDrafts(preview);draftRemoval=nil}catch{store.error=error.localizedDescription;draftRemoval=nil}
                                }.frame(minHeight:44).disabled(preview.uncertainCount>0 || preview.draftCount==0)
                                    .accessibilityIdentifier("confirm-phone-draft-removal")
                            } footer:{Text("Uncertain sends must be reconciled first. Computer chats, pairing credentials, delivery receipts, other computers and previously exported copies remain.")}
                        }.navigationTitle("Draft removal").navigationBarTitleDisplayMode(.inline)
                            .toolbar{ToolbarItem(placement:.topBarTrailing){Button("Cancel"){draftRemoval=nil}}}
                    }
                }
        }
    }
}
