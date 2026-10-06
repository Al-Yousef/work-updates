import SwiftUI
@main struct WorkUpdatesApp: App {
    @StateObject private var store = WorkStore()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            QueueView().environmentObject(store)
                .modifier(PreviewPreferences())
                .onChange(of:phase,initial:true) {_,value in store.setActive(value == .active)}
        }
    }
}

private struct PreviewPreferences:ViewModifier {
    @ViewBuilder func body(content:Content) -> some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--large-type") {
            content.dynamicTypeSize(.accessibility2)
        } else {content}
        #else
        content
        #endif
    }
}
