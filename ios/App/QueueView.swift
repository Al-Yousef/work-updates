import SwiftUI
import WorkUpdatesCore

struct QueueView: View {
    @EnvironmentObject private var store:WorkStore
    @State private var selected:DisplayCard?
    @State private var showDevices=false
    @State private var showComposer=false
    @State private var view="Updates"
    @State private var showHidden=false
    private var visible:[DisplayCard] {
        if view=="Done" {return store.done}
        return store.cards.filter{card in
            !((card.task.done ?? false)) && (view=="Queued" ? card.task.status=="queued" :
                card.task.status != "queued" && (showHidden || (card.task.reviewed != true && card.task.snoozed != true)))
        }
    }
    var body:some View {
        NavigationStack {
            ZStack {
                LinearGradient(colors:[Color(red:0.07,green:0.23,blue:0.4),Color(red:0.03,green:0.09,blue:0.22)],startPoint:.topLeading,endPoint:.bottomTrailing).ignoresSafeArea()
                ScrollView {
                    VStack(spacing:16) {
                        TimelineView(.periodic(from:.now,by:60)) {context in
                            VStack(spacing:3) {
                                Text(context.date,format:.dateTime.weekday(.wide).month(.wide).day()).font(.subheadline)
                                Text(context.date,style:.time).font(.system(size:52,weight:.light)).monospacedDigit()
                            }.padding(.top,24).padding(.bottom,18).accessibilityElement(children:.combine)
                        }
                        HStack {
                            Menu {
                                ForEach(["Updates","Queued","Done"],id:\.self){value in Button(value){view=value}}
                                Toggle("Show reviewed and snoozed",isOn:$showHidden)
                            } label:{Label(view,systemImage:"chevron.down").font(.headline).frame(minHeight:44)}
                            .accessibilityIdentifier("queue-menu")
                            Spacer()
                        }
                        if store.computers.isEmpty {
                            ContentUnavailableView {
                                Label("Your work, together",systemImage:"rectangle.stack")
                            } description:{Text("Connect your Windows PC and Mac to see their chats and tasks here.")}
                            actions:{Button("Connect a computer"){showDevices=true}.buttonStyle(.borderedProminent)}
                        } else if visible.isEmpty {
                            ContentUnavailableView(view=="Updates" ? "You’re caught up" : "No \(view.lowercased()) tasks",systemImage:"checkmark.circle",
                                description:Text(store.computers.allSatisfy{store.online($0.id)} ? "New recorded updates appear here." : "A computer is offline. Its queue refreshes when it reconnects."))
                        }
                        ForEach(visible) {card in
                            Button {selected=card} label:{NotificationCard(card:card,online:store.online(card.computerID),computerName:store.name(card.computerID))}
                                .buttonStyle(.plain).accessibilityIdentifier("notification-"+card.task.id)
                        }
                        Text(store.demo ? "Sample queue · preview only" : store.connectionText).font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("connection-status")
                        if let computer=store.lastUndoComputer {
                            Button("Undo last action") {Task{do{try await store.command("undo",computerID:computer,input:[:])}catch{store.error=error.localizedDescription}}}
                                .frame(minHeight:44).buttonStyle(.bordered)
                        }
                    }.padding(.horizontal,18).padding(.bottom,24)
                }.refreshable {store.reconnect()}
            }
            .navigationTitle("Work Updates").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.topBarLeading){Button{showDevices=true}label:{Image(systemName:"desktopcomputer").frame(minWidth:44,minHeight:44)}.accessibilityLabel("Your devices").accessibilityIdentifier("devices")}
                ToolbarItem(placement:.topBarTrailing){Button{showComposer=true}label:{Image(systemName:"plus").frame(minWidth:44,minHeight:44)}.accessibilityLabel("New task").accessibilityIdentifier("new-task")}
            }
            .sheet(item:$selected){card in ChatView(selection:card).environmentObject(store).presentationDetents([.medium,.large]).presentationDragIndicator(.visible)}
            .sheet(isPresented:$showDevices){DevicesView().environmentObject(store)}
            .sheet(isPresented:$showComposer){ComposerView(onQueued:{start in view=start ? "Updates" : "Queued"}).environmentObject(store)}
            .workErrorAlert(store,when:selected == nil && !showDevices && !showComposer)
        }.preferredColorScheme(.dark)
    }
}
struct NotificationCard:View {
    let card:DisplayCard
    let online:Bool
    let computerName:String
    var body:some View {
        VStack(alignment:.leading,spacing:8) {
            HStack(spacing:10) {
                StatusIcon(task:card.task,online:online)
                Text(card.task.chatName ?? "New chat").font(.caption.weight(.semibold)).lineLimit(1)
                Spacer(minLength:4)
                if !online {Text("Offline").font(.caption).foregroundStyle(.secondary)}
            }
            Text(card.task.title).font(.headline).multilineTextAlignment(.leading).lineLimit(3)
            if let summary=card.task.summary,!summary.isEmpty {Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)}
            Text(card.task.label+(card.task.urgent==true ? " · Urgent" : "")+(!online ? " · \(computerName) offline" : ""))
                .font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth:.infinity,alignment:.leading).padding(18)
            .background(.regularMaterial,in:RoundedRectangle(cornerRadius:28,style:.continuous))
            .overlay(RoundedRectangle(cornerRadius:28,style:.continuous).stroke(.white.opacity(0.12),lineWidth:0.5))
            .accessibilityElement(children:.combine)
    }
}
struct StatusIcon:View {
    let task:TaskCard
    let online:Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var working:Bool {online && ["working","starting"].contains(task.status)}
    private var color:Color {
        if !online {return .secondary}
        switch task.status {case "working","starting":return .cyan;case "needs":return .orange;case "blocked":return .red;case "ready","done":return .mint;case "waiting":return .purple;default:return .secondary}
    }
    private var kind:String {task.sources.first(where:{$0.id==task.primarySourceId})?.device?.kind ?? task.sources.first?.device?.kind ?? task.device?.kind ?? "unknown"}
    private var symbol:String {switch kind{case "pc","linux":return "desktopcomputer";case "mac":return "laptopcomputer";case "phone":return "iphone";case "tablet":return "ipad";default:return "rectangle.stack"}}
    var body:some View {
        ZStack(alignment:.bottomTrailing) {
            ZStack {
                Circle().stroke(color.opacity(0.25),lineWidth:2)
                if working && !reduceMotion {ProgressView().tint(color).scaleEffect(1.3)}
                else {Circle().trim(from:0,to:working ? 0.7 : 1).stroke(color,lineWidth:2)}
                Image(systemName:symbol).font(.system(size:15)).foregroundStyle(color)
            }.frame(width:34,height:34)
            Image(systemName:!online ? "wifi.slash" : task.status=="needs" ? "person.fill" : task.status=="blocked" ? "exclamationmark" : task.status=="ready" || task.status=="done" ? "checkmark" : "circle.fill")
                .font(.system(size:7,weight:.bold)).frame(width:13,height:13).background(color,in:Circle()).foregroundStyle(.black).offset(x:2,y:2)
        }.accessibilityLabel((task.device?.label ?? kind)+", "+task.label+(!online ? ", offline" : ""))
    }
}

extension View {
    func workErrorAlert(_ store:WorkStore,when visible:Bool=true) -> some View {
        alert("Work Updates",isPresented:Binding(get:{visible && store.error != nil},set:{if !$0 {store.error=nil}})) {
            Button("OK"){store.error=nil}
        } message:{Text(store.error ?? "")}
    }
}
