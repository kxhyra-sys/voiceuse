import Foundation

public struct Screenshot: Sendable {
    public let data: Data
    public let mediaType: String
    public let width: Int
    public let height: Int

    public init(data: Data, mediaType: String, width: Int, height: Int) {
        self.data = data
        self.mediaType = mediaType
        self.width = width
        self.height = height
    }
}

public enum ActionOutput: Sendable {
    case text(String)
    case image(Screenshot)
}

/// Executes computer actions on a real (or fake) screen.
public protocol ComputerBackend: AnyObject {
    func perform(_ action: ComputerAction) async throws -> ActionOutput
}

public struct AgentConfig {
    public var model = "claude-opus-5-5"
    public var effort = "medium"
    public var maxTokens = 16000
    public var maxSteps = 40
    /// Server-side refusal fallback and progress-note thinking summaries. Both are betas; the agent
    /// drops them for good if the API rejects the request with a 400.
    public var useBetaFeatures = true
    public var systemPrompt = Prompt.system

    public init() {}
}

public struct AgentEvents {
    /// A short progress note from Claude ("Opening Safari…").
    public var onNote: (String) -> Void = { _ in }
    /// What the agent is about to do, e.g. "clicking (640, 60)".
    public var onAction: (ComputerAction) -> Void = { _ in }
    public var onLog: (String) -> Void = { _ in }

    public init() {}
}

public enum AgentOutcome: Equatable {
    /// Claude finished and has something to say.
    case reply(String)
    /// Hit the step cap before finishing.
    case stepLimit
    /// The model declined the request.
    case refused(String)
    /// The response was cut off by max_tokens.
    case truncated(String)
}

/// Drives the Messages API computer-use loop. Keeps the conversation between calls so follow-ups
/// ("now close it") have context; call `reset()` to start fresh.
public final class ComputerAgent {
    public static let betaFallback = "server-side-fallback-2026-07-01"
    public static let betaThinkingUpdates = "thinking-display-updates-2026-08-18"

    public var config: AgentConfig
    public var events = AgentEvents()
    private let transport: MessagesTransport
    private let backend: ComputerBackend
    private var messages: [[String: Any]] = []

    public init(transport: MessagesTransport, backend: ComputerBackend, config: AgentConfig = AgentConfig()) {
        self.transport = transport
        self.backend = backend
        self.config = config
    }

    public var messageCount: Int { messages.count }

    public func reset() { messages.removeAll() }

    // MARK: Request

    public func buildRequest() throws -> (body: Data, betas: [String]) {
        var body: [String: Any] = [
            "model": config.model,
            "max_tokens": config.maxTokens,
            "system": config.systemPrompt,
            "tools": [["type": "computer_toolset_20260801"]],
            "messages": messages,
            "output_config": ["effort": config.effort],
            // Auto-caches the growing prefix, so each step only pays for the newest screenshot.
            "cache_control": ["type": "ephemeral"],
        ]
        var betas: [String] = []
        if config.useBetaFeatures {
            body["fallbacks"] = "default"
            body["thinking"] = ["type": "adaptive", "display": "updates"]
            betas = [Self.betaFallback, Self.betaThinkingUpdates]
        }
        return (try JSONSerialization.data(withJSONObject: body), betas)
    }

    // MARK: Loop

    public func run(userText: String) async throws -> AgentOutcome {
        messages.append(["role": "user", "content": [["type": "text", "text": userText]]])
        do {
            return try await loop()
        } catch {
            repairHistory()
            throw error
        }
    }

    /// After a cancel or failure mid-turn, an assistant `tool_use` may have no `tool_result`. The API
    /// rejects that, so answer each dangling call with an error result and keep the history valid.
    private func repairHistory() {
        guard let last = messages.last, last["role"] as? String == "assistant",
              let content = last["content"] as? [[String: Any]] else { return }
        let dangling = content.filter { $0["type"] as? String == "tool_use" }
        guard !dangling.isEmpty else { return }
        let results: [[String: Any]] = dangling.map {
            ["type": "tool_result", "tool_use_id": $0["id"] as? String ?? "", "toolset_name": "computer",
             "is_error": true, "content": "Interrupted before this action ran."]
        }
        messages.append(["role": "user", "content": results])
    }

    private func loop() async throws -> AgentOutcome {
        for step in 1...config.maxSteps {
            try Task.checkCancellation()
            let response = try await request()
            guard let content = response["content"] as? [[String: Any]] else {
                throw AgentError.badResponse("no content array")
            }
            messages.append(["role": "assistant", "content": content])
            let stopReason = response["stop_reason"] as? String ?? ""
            events.onLog("step \(step): stop_reason=\(stopReason), \(content.count) blocks")

            for block in content where block["type"] as? String == "thinking" {
                if let note = (block["thinking"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !note.isEmpty {
                    events.onNote(note)
                }
            }
            let text = content
                .filter { $0["type"] as? String == "text" }
                .compactMap { $0["text"] as? String }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            switch stopReason {
            case "tool_use":
                if !text.isEmpty { events.onNote(text) }
                let toolUses = content.filter { $0["type"] as? String == "tool_use" }
                let results = try await execute(toolUses)
                messages.append(["role": "user", "content": results])
            case "pause_turn":
                continue
            case "refusal":
                let detail = (response["stop_details"] as? [String: Any])?["explanation"] as? String
                return .refused(detail ?? "I can't help with that one.")
            case "max_tokens":
                return .truncated(text)
            default: // end_turn, stop_sequence
                return .reply(text)
            }
        }
        return .stepLimit
    }

    /// Sends the request; on a 400 with the beta features on, retries once without them.
    private func request() async throws -> [String: Any] {
        while true {
            let (body, betas) = try buildRequest()
            do {
                let data = try await transport.send(body: body, betas: betas)
                guard let json = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    throw AgentError.badResponse("not a JSON object")
                }
                return json
            } catch AgentError.api(let status, let type, let message) where status == 400 && config.useBetaFeatures {
                events.onLog("400 with beta features (\(type): \(message)); retrying without them")
                config.useBetaFeatures = false
            }
        }
    }

    private func execute(_ toolUses: [[String: Any]]) async throws -> [[String: Any]] {
        var results: [[String: Any]] = []
        var failed = false
        for use in toolUses {
            try Task.checkCancellation()
            let id = use["id"] as? String ?? ""
            var result: [String: Any] = ["type": "tool_result", "tool_use_id": id, "toolset_name": "computer"]

            if failed {
                result["is_error"] = true
                result["content"] = "Not executed: an earlier computer action in this turn failed."
                results.append(result)
                continue
            }
            let name = use["name"] as? String ?? ""
            let input = use["input"] as? [String: Any] ?? [:]
            guard use["toolset_name"] as? String == "computer" else {
                failed = true
                result["is_error"] = true
                result["content"] = "Unknown tool '\(name)'. Only the computer tools are available."
                results.append(result)
                continue
            }

            do {
                let action = try ComputerAction.parse(name: name, input: input)
                events.onAction(action)
                switch try await backend.perform(action) {
                case .text(let text):
                    result["content"] = [["type": "text", "text": text]]
                case .image(let shot):
                    result["content"] = [[
                        "type": "image",
                        "source": ["type": "base64", "media_type": shot.mediaType,
                                   "data": shot.data.base64EncodedString()],
                    ]]
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failed = true
                result["is_error"] = true
                result["content"] = "\(error)"
                events.onLog("action '\(name)' failed: \(error)")
            }
            results.append(result)
        }
        return results
    }
}
