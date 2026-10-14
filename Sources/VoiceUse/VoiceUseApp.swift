import AppKit
import SwiftUI

@main
struct VoiceUseApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
        } label: {
            Image(systemName: model.menuIcon)
        }
        .menuBarExtraStyle(.menu)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hud: HUDController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Task { @MainActor in
            let model = AppModel.shared
            hud = HUDController(model: model)
            model.start()
        }
    }
}

struct MenuView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Text(model.statusLine)
        Divider()
        Button(model.phase == .idle ? "Talk   ⌃⌥Space" : "Stop   ⌃⌥Space") { model.toggleTalk() }
        Button("Type a Command…") { model.promptTyped() }
            .disabled(model.phase != .idle)
        Button("New Conversation") { model.resetConversation() }
        Divider()
        Menu("Permissions") {
            permissionRow("Microphone & Speech", model.permissions.canTalk) { model.requestMicAndSpeech() }
            permissionRow("Accessibility (click & type)", model.permissions.accessibility) { model.requestAccessibility() }
            permissionRow("Screen Recording (see the screen)", model.permissions.screenRecording) { model.requestScreenRecording() }
        }
        Picker("Model", selection: $model.modelID) {
            ForEach(AppModel.models, id: \.id) { Text($0.name).tag($0.id) }
        }
        Button(model.hasKey ? "Change API Key…" : "Set API Key…") { model.promptForKey() }
        Button("Show Log") { NSWorkspace.shared.open(Log.url) }
        Divider()
        Button("Quit VoiceUse") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    @ViewBuilder
    private func permissionRow(_ title: String, _ granted: Bool, _ action: @escaping () -> Void) -> some View {
        if granted {
            Text("✓  \(title)")
        } else {
            Button("Grant…  \(title)", action: action)
        }
    }
}
