import SwiftUI
import WorkUpdatesCore

struct ChatView:View {
    @EnvironmentObject private var store:WorkStore
    @Environment(\.dismiss) private var dismiss
    @State private var selection:DisplayCard
    @State private var sourceID:String?
    @State private var draft=""
    @State private var pendingTaskID:String?
    @State private var ownerName=""
    @State private var submitting=false
    @State private var loadedBinding:DraftBinding?
    @State private var draftSaveFailed=false
    init(selection:DisplayCard) {_selection=State(initialValue:selection)}
    private var card:DisplayCard? {store.current(selection)}
    private func source(_ task:TaskCard) -> ChatSource? {
        task.sources.first{$0.id==(sourceID ?? task.primarySourceId)} ?? task.sources.first
    }
    private func run(_ operation:@escaping () async throws -> Void) {
        Task {do{try await operation()}catch{store.error=error.localizedDescription}}
    }
    var body:some View {
        NavigationStack {
            Group {
            if let card {
                let task=card.task
                let available=store.online(card.computerID)
                let waiting=store.approvals(card)
                let sending=submitting || store.busy.contains(card.computerID+":"+task.id)
                ScrollView {
                    VStack(alignment:.leading,spacing:18) {
                        NotificationCard(card:card,online:available,computerName:store.name(card.computerID))
                        if !available {
                            Label("\(store.name(card.computerID)) is offline. This is its last recorded update.",systemImage:"wifi.slash")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        if task.sources.count>1 {
                            Picker("Source chat",selection:Binding(get:{sourceID ?? task.primarySourceId ?? task.sources[0].id},set:{restoreDraft(card,sourceID:$0)})) {
                                ForEach(task.sources){s in Text(s.title ?? "Chat").tag(s.id)}
                            }.pickerStyle(.menu).disabled(sending)
                        }
                        Text("Chat · "+(source(task)?.title ?? task.chatName ?? "New chat")).font(.subheadline.weight(.semibold))
                        ForEach(waiting){request in ApprovalView(request:request,computerID:card.computerID,available:available)}
                        if task.kind=="observed" {
                            Text(source(task)?.body ?? task.summary ?? "No recorded context yet.").textSelection(.enabled)
                                .padding(14).frame(maxWidth:.infinity,alignment:.leading).background(.thinMaterial,in:RoundedRectangle(cornerRadius:18))
                        } else {
                            ForEach(task.messages ?? []) {message in
                                HStack {
                                    if message.role=="user" {Spacer(minLength:24)}
                                    Text(message.text).textSelection(.enabled).padding(12)
                                        .background(message.role=="user" ? Color.blue.opacity(0.7) : Color.white.opacity(0.09),in:RoundedRectangle(cornerRadius:18))
                                    if message.role != "user" {Spacer(minLength:24)}
                                }
                            }
                        }
                        if let error=task.replyError ?? task.error,!error.isEmpty {Text(error).font(.footnote).foregroundStyle(.orange).textSelection(.enabled)}
                        if task.done != true {
                            let replyAllowed=available && !task.sources.isEmpty && waiting.isEmpty &&
                                !(task.kind=="observed" && source(task)?.lifecycle=="working") && !sending
                            HStack(alignment:.bottom,spacing:10) {
                                ReplyInput(text:$draft,enabled:!sending && loadedBinding != nil,onSubmit:{send(card)})
                                    .accessibilityIdentifier("chat-input")
                                Button{send(card)}label:{Image(systemName:"arrow.up").font(.headline).frame(width:44,height:44).background(.blue,in:Circle())}
                                    .accessibilityLabel("Send message").accessibilityIdentifier("send-message")
                                    .disabled(!replyAllowed || draftSaveFailed || draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                            }
                            if let binding=loadedBinding {
                                if store.channelDrafts?.hasUnconfirmed(computerID:binding.computerID,hostID:binding.hostID,sourceID:binding.sourceID)==true {
                                    Text("Delivery is unconfirmed. Your saved draft is retained.").font(.footnote).foregroundStyle(.orange)
                                    Button("Check delivery"){store.reconnect()}.disabled(!available || sending)
                                } else if !draft.isEmpty && !draftSaveFailed {
                                    Text("Draft saved on this iPhone").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            if task.status=="queued" || (task.kind=="local" && task.status=="blocked") {
                                Button(task.threadId == nil ? "Start chat" : "Retry in this chat") {
                                    run{try await store.command("start",computerID:card.computerID,input:["id":.string(task.id)],lock:task.id)}
                                }.buttonStyle(.borderedProminent).disabled(!available || sending).accessibilityIdentifier("start-chat")
                            }
                        }
                        VStack(spacing:0) {
                            if let activeSource=source(task) {
                                actionButton("Open on "+store.name(card.computerID),symbol:"arrow.up.forward") {
                                    run{try await store.command("open",computerID:card.computerID,input:["id":.string(task.id),"taskKey":.string(task.taskKey),"sourceId":.string(activeSource.id)],lock:task.id)}
                                }
                                Divider()
                            }
                            if task.done != true {
                                actionButton("Reviewed",symbol:"checkmark") {run{try await store.action(card,"reviewed");dismiss()}}.accessibilityIdentifier("reviewed")
                                Divider()
                                actionButton("Snooze 1h",symbol:"moon") {run{try await store.action(card,"snooze");dismiss()}}.accessibilityIdentifier("snooze")
                            } else {
                                actionButton("Reopen task",symbol:"arrow.counterclockwise") {run{try await store.action(card,"reopen");dismiss()}}
                            }
                        }.background(.regularMaterial,in:RoundedRectangle(cornerRadius:20)).disabled(!available || sending)
                        if task.done != true {
                            DisclosureGroup("Task settings") {
                                VStack(alignment:.leading,spacing:12) {
                                    Button("Complete task"){run{try await store.action(card,"done");dismiss()}}.frame(minHeight:44)
                                        .disabled(!task.canComplete || !waiting.isEmpty).accessibilityIdentifier("complete-task")
                                    Menu("Priority") {
                                        ForEach(["auto","urgent","normal"],id:\.self){v in
                                            Button(v=="auto" ? "Automatic" : v.capitalized){run{try await store.action(card,"priority:"+v)}}
                                        }
                                    }.frame(minHeight:44)
                                    TextField("Waiting on a person or team",text:$ownerName).textFieldStyle(.roundedBorder)
                                    Button("Save waiting owner"){run{try await store.action(card,"owner:"+ownerName)}}.frame(minHeight:44).disabled(ownerName.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                                    Button("Automatic status"){run{try await store.action(card,"status:auto")}}.frame(minHeight:44)
                                    if task.kind=="local" && ["working","needs"].contains(task.status) && !task.canComplete {
                                        Button("Stop current pass",role:.destructive){run{try await store.command("stop",computerID:card.computerID,input:["id":.string(task.id)],lock:task.id)}}.frame(minHeight:44)
                                    }
                                }.padding(.top,12)
                            }.disabled(!available || sending)
                        }
                    }.padding(18)
                }.navigationTitle("Task & chat").navigationBarTitleDisplayMode(.inline)
                    .task(id:task.taskKey+":"+(task.contextRevision ?? "")) {
                        restoreDraft(card,sourceID:sourceID ?? task.primarySourceId ?? task.sources.first?.id)
                        if available && task.kind=="observed" {
                            try? await store.command("details",computerID:card.computerID,input:["id":.string(task.id),"taskKey":.string(task.taskKey)],lock:"details:"+task.id)
                        }
                    }
            } else {
                ContentUnavailableView("This task changed",systemImage:"arrow.clockwise",description:Text("Return to the queue and open its latest update."))
            }
            }.toolbar {ToolbarItem(placement:.topBarTrailing){Button("Done"){dismiss()}.accessibilityIdentifier("dismiss-chat")}}
                .workErrorAlert(store)
        }
            .onReceive(store.$states) {_ in
                if let target=pendingTaskID,let next=store.cards.first(where:{$0.computerID==selection.computerID && $0.task.id==target}) {selection=next;pendingTaskID=nil}
                Task { @MainActor in
                    guard !submitting,let card=self.card,let binding=loadedBinding,
                          (try? store.channelBinding(card,sourceID:binding.sourceID))==binding,
                          store.channelDrafts?.draft(binding)?.status=="accepted" else {return}
                    do {draft=try store.draftText(binding)} catch {store.error=error.localizedDescription}
                }
            }
            .onChange(of:draft) {_,text in
                guard let binding=loadedBinding else {return}
                do {try store.saveDraft(binding,text:text);draftSaveFailed=false}
                catch {draftSaveFailed=true;store.error="Keep this draft open. "+error.localizedDescription}
            }
    }
    @ViewBuilder private func actionButton(_ title:String,symbol:String,action:@escaping()->Void) -> some View {
        Button(action:action){Label(title,systemImage:symbol).frame(maxWidth:.infinity,alignment:.leading).frame(minHeight:44).padding(.horizontal,16).padding(.vertical,4)}.buttonStyle(.plain)
    }
    private func send(_ card:DisplayCard) {
        let text=draft.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !submitting,!draftSaveFailed,!text.isEmpty,store.online(card.computerID),let source=source(card.task),let binding=loadedBinding else{return}
        submitting=true
        run {
            defer{submitting=false}
            guard try store.channelBinding(card,sourceID:source.id)==binding else {throw PeerError.server("Open the original saved source before sending.")}
            try store.saveDraft(binding,text:draft)
            let result=try await store.sendDraft(card,sourceID:source.id)
            guard let currentCard=self.card,selection.computerID==card.computerID,
                  currentCard.task.taskKey==card.task.taskKey,self.source(currentCard.task)?.id == source.id
            else {throw PeerError.server("The message was accepted in its original chat. Reopen that chat to inspect it.")}
            draft=try store.draftText(binding)
            if let id=result.object?["taskId"]?.string,id != card.task.id {
                if let next=store.cards.first(where:{$0.computerID==card.computerID && $0.task.id==id}) {selection=next}
                else {pendingTaskID=id}
            }
        }
    }
    private func restoreDraft(_ card:DisplayCard,sourceID requested:String?) {
        guard let requested else {return}
        do {
            if let loadedBinding {try store.saveDraft(loadedBinding,text:draft)}
            let binding=try store.channelBinding(card,sourceID:requested)
            let saved=try store.draftText(binding)
            loadedBinding=binding;sourceID=requested;draft=saved;draftSaveFailed=false
        } catch {draftSaveFailed=true;store.error="The original draft is retained. "+error.localizedDescription}
    }
}
struct ReplyInput:UIViewRepresentable {
    @Binding var text:String
    let enabled:Bool
    let onSubmit:()->Void
    func makeCoordinator()->Coordinator {Coordinator(self)}
    func makeUIView(context:Context)->UITextView {
        let view=UITextView()
        view.delegate=context.coordinator
        view.font=UIFont.preferredFont(forTextStyle:.body)
        view.adjustsFontForContentSizeCategory=true
        view.backgroundColor=UIColor.secondarySystemFill
        view.layer.cornerRadius=18
        view.textContainerInset=UIEdgeInsets(top:12,left:10,bottom:12,right:10)
        view.returnKeyType = .send
        view.accessibilityLabel="Chat message"
        view.accessibilityIdentifier="chat-input"
        return view
    }
    func updateUIView(_ view:UITextView,context:Context) {
        context.coordinator.parent=self
        if view.text != text {view.text=text}
        view.isEditable=enabled;view.isSelectable=enabled
    }
    func sizeThatFits(_ proposal:ProposedViewSize,uiView:UITextView,context:Context)->CGSize? {
        let width=proposal.width ?? 260
        return CGSize(width:width,height:min(140,max(48,uiView.sizeThatFits(CGSize(width:width,height:.greatestFiniteMagnitude)).height)))
    }
    final class Coordinator:NSObject,UITextViewDelegate {
        var parent:ReplyInput
        init(_ parent:ReplyInput){self.parent=parent}
        func textViewDidChange(_ textView:UITextView){parent.text=textView.text}
        func textView(_ textView:UITextView,shouldChangeTextIn range:NSRange,replacementText text:String)->Bool {
            if text=="\n" {if parent.enabled{parent.onSubmit()};return false}
            return (textView.text as NSString).length-range.length+(text as NSString).length<=12000
        }
    }
}
struct ApprovalView:View {
    @EnvironmentObject private var store:WorkStore
    let request:Approval
    let computerID:String
    let available:Bool
    @State private var answers:[String:String]=[:]
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            Label(request.kind=="question" ? "Your answer is needed" : "Permission needed",systemImage:"person.crop.circle.badge.exclamationmark").font(.headline)
            if let reason=request.reason,!reason.isEmpty{Text(reason)}
            if let command=request.command,!command.isEmpty{Text(command).font(.system(.footnote,design:.monospaced)).textSelection(.enabled)}
            if let cwd=request.cwd,!cwd.isEmpty{Text("Workspace: "+cwd).font(.footnote).textSelection(.enabled)}
            if let root=request.grantRoot,!root.isEmpty{Text("File changes in "+root).font(.footnote).textSelection(.enabled)}
            if request.kind=="permissions",let permissions=request.permissions {Text(permissions.pretty).font(.system(.footnote,design:.monospaced)).textSelection(.enabled)}
            if request.kind=="question" {
                ForEach(request.questions ?? []){question in
                    Text(question.question)
                    ForEach(question.options ?? [],id:\.label){option in
                        Button {answers[question.id]=option.label} label:{
                            VStack(alignment:.leading){Text(option.label);if let detail=option.description{Text(detail).font(.caption).foregroundStyle(.secondary)}}.frame(minHeight:44)
                        }.buttonStyle(.bordered)
                    }
                    TextField("Your answer",text:Binding(get:{answers[question.id] ?? ""},set:{answers[question.id]=$0})).textFieldStyle(.roundedBorder)
                }
                Button("Send answer"){respond(answers:answers)}.buttonStyle(.borderedProminent)
                    .disabled((request.questions ?? []).contains{(answers[$0.id] ?? "").trimmingCharacters(in:.whitespacesAndNewlines).isEmpty})
            } else {
                HStack {
                    Button("Allow once"){respond(decision:"accept")}.buttonStyle(.borderedProminent)
                    Button("Deny",role:.destructive){respond(decision:"decline")}.buttonStyle(.bordered)
                }.frame(minHeight:44)
            }
        }.padding(16).background(.orange.opacity(0.12),in:RoundedRectangle(cornerRadius:18))
            .disabled(!available || store.busy.contains(computerID+":approval:"+request.id))
    }
    private func respond(decision:String?=nil,answers:[String:String]?=nil) {
        Task {do {
            var input:[String:JSONValue]=["id":.string(request.id)]
            if let decision{input["decision"] = .string(decision)}
            if let answers{input["answers"] = .object(answers.mapValues{.string($0)})}
            try await store.command("respond",computerID:computerID,input:input,lock:"approval:"+request.id)
        } catch {store.error=error.localizedDescription}}
    }
}
