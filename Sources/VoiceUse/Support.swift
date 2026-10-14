import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation
import Security
import Speech

// MARK: Logging

enum Log {
    static let url: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs", isDirectory: true)
        return dir.appendingPathComponent("VoiceUse.log")
    }()

    private static let queue = DispatchQueue(label: "voiceuse.log")
    private static let formatter: ISO8601DateFormatter = ISO8601DateFormatter()

    static func write(_ message: String) {
        let line = "\(formatter.string(from: Date())) \(message)\n"
        queue.async {
            guard let data = line.data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
    }
}

// MARK: API key storage

enum KeyStore {
    private static let service = "dev.voiceuse.app"
    private static let account = "anthropic-api-key"

    /// Keychain first, then ANTHROPIC_API_KEY from the environment (handy for `swift run`).
    static func apiKey() -> String? {
        if let stored = read(), !stored.isEmpty { return stored }
        let env = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"]
        return (env?.isEmpty == false) ? env : nil
    }

    static var hasKey: Bool { apiKey() != nil }

    static func read() -> String? {
        var item: CFTypeRef?
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ key: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !key.isEmpty, let data = key.data(using: .utf8) else { return true }
        var add = base
        add[kSecValueData as String] = data
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}

// MARK: Permissions

struct PermissionStatus: Equatable {
    var microphone: Bool
    var speech: Bool
    var accessibility: Bool
    var screenRecording: Bool

    static func current() -> PermissionStatus {
        PermissionStatus(
            microphone: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
            speech: SFSpeechRecognizer.authorizationStatus() == .authorized,
            accessibility: AXIsProcessTrusted(),
            screenRecording: CGPreflightScreenCaptureAccess()
        )
    }

    var allGranted: Bool { microphone && speech && accessibility && screenRecording }
    var canTalk: Bool { microphone && speech }
    var canAct: Bool { accessibility && screenRecording }
}
