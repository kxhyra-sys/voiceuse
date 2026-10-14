import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI
import VoiceUseCore

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Phase: Equatable { case idle, listening, working, speaking }

    static let models: [(name: String, id: String)] = [
        ("Claude Opus 5.5", "claude-opus-5-5"),
        ("Claude Sonnet 5.5 (faster, cheaper)", "claude-sonnet-5-5"),
    ]

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var transcript = ""
    @Published private(set) var note = ""
    @Published private(set) var reply = ""
    @Published private(set) var problem: String?
    @Published private(set) var permissions = PermissionStatus.current()
    @Published private(set) var hasKey = KeyStore.hasKey
    @Published private(set) var hudVisible = false
    @Published var modelID: String {
        didSet {
            UserDefaults.standard.set(modelID, forKey: "modelID")
            agent.config.model = modelID
        }
    }

    private let listener = SpeechListener()
    private let speaker = Speaker()
    private let backend = MacComputerBackend()
    private let hotkeys = HotKeys()
    private let agent: ComputerAgent
    private var runTask: Task<Void, Never>?
    private var lastActivity = Date()
    private var hudGeneration = 0
    private var actionCount = 0

    private let voiceAvailable = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil

    private init() {
        let env = ProcessInfo.processInfo.environment["VOICEUSE_MODEL"]
        let stored = UserDefaults.standard.string(forKey: "modelID")
        let initial = env ?? stored ?? Self.models[0].id
        modelID = initial

        var config = AgentConfig()
        config.model = initial
        agent = ComputerAgent(transport: URLSessionTransport(apiKey: { KeyStore.apiKey() }),
                              backend: backend, config: config)
        agent.events.onLog = { Log.write($0) }
        agent.events.onNote = { [weak self] text in
            Task { @MainActor in self?.note = text }
        }
        agent.events.onAction = { [weak self] action in
            Task { @MainActor in
                guard let self else { return }
                self.actionCount += 1
                if case .screenshot = action {} else { self.note = action.summary.prefix(1).uppercased() + action.summary.dropFirst() }
            }
        }
    }

    // MARK: Lifecycle

    func start() {
        Log.write("VoiceUse started, model \(modelID), voice \(voiceAvailable ? "on" : "off (no bundle)")")
        hotkeys.onPress = { [weak self] key in
            Task { @MainActor in
                switch key {
                case .talk: self?.toggleTalk()
                case .stop: self?.stop()
                }
            }
        }
        hotkeys.register()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
        if !UserDefaults.standard.bool(forKey: "didOnboard"),
           ProcessInfo.processInfo.environment["VOICEUSE_NO_ONBOARD"] == nil {
            UserDefaults.standard.set(true, forKey: "didOnboard")
            Task { await onboard() }
        }
    }

    func refreshStatus() {
        let current = PermissionStatus.current()
        if current != permissions { permissions = current }
        let key = KeyStore.hasKey
        if key != hasKey { hasKey = key }
    }

    // MARK: Talking

    var statusLine: String {
        if let problem { return "⚠︎ \(problem)" }
        switch phase {
        case .idle: return "Ready. Press ⌃⌥Space and speak."
        case .listening: return "Listening…"
        case .working: return note.isEmpty ? "Working…" : note
        case .speaking: return "Speaking…"
        }
    }

    var menuIcon: String {
        switch phase {
        case .idle: return "waveform"
        case .listening: return "mic.fill"
        case .working: return "sparkles"
        case .speaking: return "speaker.wave.2.fill"
        }
    }

    func toggleTalk() {
        switch phase {
        case .idle: beginListening()
        case .listening: listener.finish()
        case .working: stop()
        case .speaking: speaker.stop(); setPhase(.idle)
        }
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        listener.cancel()
        speaker.stop()
        backend.cleanup()
        if phase != .idle { note = "Stopped." }
        setPhase(.idle)
    }

    func resetConversation() {
        agent.reset()
        note = "Started a new conversation."
        reply = ""
    }

    private func beginListening() {
        problem = nil
        guard voiceAvailable else {
            problem = "Voice needs the app bundle. Run scripts/build-app.sh and open build/VoiceUse.app."
            showHUDBriefly()
            return
        }
        refreshStatus()
        guard permissions.canTalk else {
            Task {
                _ = await SpeechListener.requestPermissions()
                refreshStatus()
                if permissions.canTalk { beginListening() } else {
                    problem = "Allow Microphone and Speech Recognition in System Settings > Privacy & Security."
                    openPrivacyPane("Privacy_Microphone")
                    showHUDBriefly()
                }
            }
            return
        }
        transcript = ""
        note = ""
        setPhase(.listening)
        do {
            try listener.start(
                onPartial: { [weak self] text in self?.transcript = text },
                onFinal: { [weak self] text in self?.heard(text) }
            )
        } catch {
            problem = "\(error)"
            setPhase(.idle)
            showHUDBriefly()
        }
    }

    private func heard(_ text: String) {
        Log.write("heard: \(text)")
        let lowered = text.lowercased().trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.whitespaces))
        guard !lowered.isEmpty else { setPhase(.idle); return }
        if ["stop", "cancel", "never mind", "nevermind", "forget it"].contains(lowered) {
            stop()
            return
        }
        if ["start over", "new conversation", "new task", "reset"].contains(lowered) {
            resetConversation()
            setPhase(.idle)
            showHUDBriefly()
            return
        }
        submit(text)
    }

    // MARK: Running a command

    /// Entry point for both voice and typed commands.
    func submit(_ text: String) {
        problem = nil
        refreshStatus()
        guard KeyStore.hasKey else {
            problem = "No API key yet. Choose Set API Key from the menu."
            setPhase(.idle)
            showHUDBriefly()
            return
        }
        guard permissions.canAct else {
            Task { await requestActionPermissions() }
            problem = permissions.accessibility ? "Allow Screen Recording, then reopen VoiceUse." : "Allow Accessibility so VoiceUse can click and type."
            setPhase(.idle)
            showHUDBriefly()
            return
        }

        transcript = text
        note = "Thinking…"
        actionCount = 0
        if Date().timeIntervalSince(lastActivity) > 600 { agent.reset() }
        lastActivity = Date()
        setPhase(.working)

        runTask = Task { [weak self] in
            guard let self else { return }
            do {
                let outcome = try await self.agent.run(userText: text)
                self.lastActivity = Date()
                await self.finish(outcome)
            } catch is CancellationError {
                self.backend.cleanup()
            } catch {
                self.backend.cleanup()
                Log.write("error: \(error)")
                let message = "\(error)"
                self.problem = message
                self.reply = ""
                await self.say(String(message.prefix(140)))
                self.setPhase(.idle)
            }
        }
    }

    private func finish(_ outcome: AgentOutcome) async {
        backend.cleanup()
        let spoken: String
        var expectsAnswer = false
        switch outcome {
        case .reply(let text):
            spoken = text.isEmpty ? "Done." : text
            expectsAnswer = text.hasSuffix("?")
        case .stepLimit:
            spoken = "I stopped after \(agent.config.maxSteps) steps without finishing. Tell me to continue if you want me to keep going."
        case .refused(let why):
            spoken = why
        case .truncated(let text):
            spoken = text.isEmpty ? "I ran out of room to answer. Try asking again." : text
        }
        Log.write("reply: \(spoken)")
        reply = spoken
        await say(spoken)
        guard !Task.isCancelled else { return }
        setPhase(.idle)
        if expectsAnswer { beginListening() } else { showHUDBriefly() }
    }

    private func say(_ text: String) async {
        setPhase(.speaking)
        await speaker.speak(text)
    }

    // MARK: Phase and HUD

    private func setPhase(_ new: Phase) {
        phase = new
        hudGeneration += 1
        hudVisible = new != .idle || hudVisible
        if new != .idle { hudVisible = true }
    }

    /// Shows the HUD for a few seconds with the latest reply or problem, then hides it.
    private func showHUDBriefly() {
        hudVisible = true
        hudGeneration += 1
        let generation = hudGeneration
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard let self, self.hudGeneration == generation, self.phase == .idle else { return }
            self.hudVisible = false
        }
    }

    // MARK: Setup dialogs

    func onboard() async {
        if !KeyStore.hasKey { promptForKey() }
        _ = await SpeechListener.requestPermissions()
        await requestActionPermissions()
        refreshStatus()
    }

    func requestActionPermissions() async {
        if !AXIsProcessTrusted() {
            AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        }
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        refreshStatus()
    }

    func requestMicAndSpeech() {
        Task {
            let result = await SpeechListener.requestPermissions()
            if !(result.mic && result.speech) { openPrivacyPane("Privacy_Microphone") }
            refreshStatus()
        }
    }

    func requestAccessibility() {
        AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        openPrivacyPane("Privacy_Accessibility")
    }

    func requestScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
        openPrivacyPane("Privacy_ScreenCapture")
    }

    func promptForKey() {
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "sk-ant-…"
        let alert = NSAlert()
        alert.messageText = "Anthropic API key"
        alert.informativeText = "Stored in your macOS Keychain. Create one at console.anthropic.com. Leave empty and press Save to remove it."
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = field
        if alert.runModal() == .alertFirstButtonReturn {
            KeyStore.save(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
            refreshStatus()
        }
    }

    func promptTyped() {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        field.placeholderString = "Open Safari and search for the weather"
        let alert = NSAlert()
        alert.messageText = "Type a command"
        alert.informativeText = "Same as speaking it."
        alert.accessoryView = field
        alert.addButton(withTitle: "Run")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.initialFirstResponder = field
        if alert.runModal() == .alertFirstButtonReturn {
            let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, phase == .idle { submit(text) }
        }
    }

    private func openPrivacyPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}
