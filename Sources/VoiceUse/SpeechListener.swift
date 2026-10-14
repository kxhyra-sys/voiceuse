import AVFoundation
import Speech

/// Streams the microphone into Apple's speech recognizer (on-device when available) and ends the
/// utterance after a pause. Delivers the final transcript exactly once.
@MainActor
final class SpeechListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Task<Void, Never>?
    private var maxTimer: Task<Void, Never>?
    private var latest = ""
    private var delivered = true
    private var onPartial: ((String) -> Void)?
    private var onFinal: ((String) -> Void)?

    /// Seconds of silence after speech before the command is sent.
    var silenceSeconds: Double = 1.3
    var maxSeconds: Double = 40

    var isListening: Bool { !delivered }

    static func requestPermissions() async -> (mic: Bool, speech: Bool) {
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        let speech = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        return (mic, speech)
    }

    enum StartError: Error, CustomStringConvertible {
        case unavailable, noPermission, engine(Error)
        var description: String {
            switch self {
            case .unavailable: return "Speech recognition is not available for this language."
            case .noPermission: return "Microphone or Speech Recognition permission is missing."
            case .engine(let error): return "Could not start the microphone: \(error.localizedDescription)"
            }
        }
    }

    func start(onPartial: @escaping (String) -> Void, onFinal: @escaping (String) -> Void) throws {
        cancel()
        guard let recognizer, recognizer.isAvailable else { throw StartError.unavailable }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
              SFSpeechRecognizer.authorizationStatus() == .authorized else { throw StartError.noPermission }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        self.onPartial = onPartial
        self.onFinal = onFinal
        latest = ""
        delivered = false

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardown()
            throw StartError.engine(error)
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let failed = error != nil
            Task { @MainActor [weak self] in
                self?.handle(text: text, isFinal: isFinal, failed: failed)
            }
        }
        maxTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((self?.maxSeconds ?? 40) * 1_000_000_000))
            if !Task.isCancelled { self?.finish() }
        }
    }

    /// Stops listening now and delivers whatever was heard.
    func finish() {
        guard !delivered else { return }
        stopAudio()
        // Give the recognizer a moment to emit its final result; otherwise use the last partial.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            self?.deliver()
        }
    }

    /// Stops listening and drops the audio without delivering anything.
    func cancel() {
        delivered = true
        teardown()
    }

    private func handle(text: String?, isFinal: Bool, failed: Bool) {
        guard !delivered else { return }
        if let text, !text.isEmpty {
            if text != latest {
                latest = text
                onPartial?(text)
                restartSilenceTimer()
            }
        }
        if isFinal || failed { deliver() }
    }

    private func restartSilenceTimer() {
        silenceTimer?.cancel()
        silenceTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((self?.silenceSeconds ?? 1.3) * 1_000_000_000))
            if !Task.isCancelled { self?.finish() }
        }
    }

    private func deliver() {
        guard !delivered else { return }
        delivered = true
        let text = latest.trimmingCharacters(in: .whitespacesAndNewlines)
        let callback = onFinal
        teardown()
        callback?(text)
    }

    private func stopAudio() {
        silenceTimer?.cancel()
        maxTimer?.cancel()
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
    }

    private func teardown() {
        stopAudio()
        task?.cancel()
        task = nil
        request = nil
        onPartial = nil
        onFinal = nil
    }
}
