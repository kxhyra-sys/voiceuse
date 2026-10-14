import XCTest
@testable import VoiceUseCore

/// Replays scripted API responses and records every request body.
final class ScriptedTransport: MessagesTransport {
    var responses: [Result<[String: Any], Error>]
    var requests: [[String: Any]] = []
    var betaHeaders: [[String]] = []

    init(_ responses: [Result<[String: Any], Error>]) { self.responses = responses }

    func send(body: Data, betas: [String]) async throws -> Data {
        requests.append(try JSONSerialization.jsonObject(with: body) as! [String: Any])
        betaHeaders.append(betas)
        guard !responses.isEmpty else { throw AgentError.badResponse("script exhausted") }
        switch responses.removeFirst() {
        case .success(let json): return try JSONSerialization.data(withJSONObject: json)
        case .failure(let error): throw error
        }
    }
}

final class FakeBackend: ComputerBackend {
    var performed: [ComputerAction] = []
    var failOn: ((ComputerAction) -> Bool)?

    func perform(_ action: ComputerAction) async throws -> ActionOutput {
        performed.append(action)
        if failOn?(action) == true { throw ActionParseError.badInput("boom") }
        if case .screenshot = action {
            return .image(Screenshot(data: Data([1, 2, 3]), mediaType: "image/jpeg", width: 10, height: 10))
        }
        return .text("OK")
    }
}

private func toolUse(_ id: String, _ name: String, _ input: [String: Any] = [:]) -> [String: Any] {
    ["type": "tool_use", "id": id, "name": name, "toolset_name": "computer", "input": input]
}

private func response(_ content: [[String: Any]], stop: String) -> Result<[String: Any], Error> {
    .success(["content": content, "stop_reason": stop])
}

final class AgentLoopTests: XCTestCase {
    func testRequestShape() throws {
        let agent = ComputerAgent(transport: ScriptedTransport([]), backend: FakeBackend())
        let (body, betas) = try agent.buildRequest()
        let json = try JSONSerialization.jsonObject(with: body) as! [String: Any]

        XCTAssertEqual(json["model"] as? String, "claude-opus-5-5")
        let tools = json["tools"] as! [[String: Any]]
        XCTAssertEqual(tools.count, 1)
        XCTAssertEqual(tools[0]["type"] as? String, "computer_toolset_20260801")
        XCTAssertNil(tools[0]["name"], "the toolset entry takes no name or display size")
        XCTAssertEqual(json["fallbacks"] as? String, "default")
        XCTAssertEqual((json["output_config"] as? [String: Any])?["effort"] as? String, "medium")
        XCTAssertEqual((json["cache_control"] as? [String: Any])?["type"] as? String, "ephemeral")
        XCTAssertEqual(betas, ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"])
    }

    func testToolLoopReturnsResultsWithToolsetName() async throws {
        let transport = ScriptedTransport([
            response([["type": "thinking", "thinking": "Opening Spotlight"],
                      toolUse("t1", "key", ["text": "super+space"]),
                      toolUse("t2", "screenshot")], stop: "tool_use"),
            response([["type": "text", "text": "Done, Safari is open."]], stop: "end_turn"),
        ])
        let backend = FakeBackend()
        let agent = ComputerAgent(transport: transport, backend: backend)
        var notes: [String] = []
        agent.events.onNote = { notes.append($0) }

        let outcome = try await agent.run(userText: "open Safari")

        XCTAssertEqual(outcome, .reply("Done, Safari is open."))
        XCTAssertEqual(backend.performed.count, 2)
        XCTAssertEqual(notes, ["Opening Spotlight"])

        let secondRequest = transport.requests[1]
        let messages = secondRequest["messages"] as! [[String: Any]]
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["user", "assistant", "user"])
        let results = messages[2]["content"] as! [[String: Any]]
        XCTAssertEqual(results.count, 2)
        for result in results {
            XCTAssertEqual(result["type"] as? String, "tool_result")
            XCTAssertEqual(result["toolset_name"] as? String, "computer")
        }
        XCTAssertEqual(results.map { $0["tool_use_id"] as? String }, ["t1", "t2"])
        let image = (results[1]["content"] as! [[String: Any]])[0]
        XCTAssertEqual(image["type"] as? String, "image")
        // The assistant turn is passed back unchanged, thinking block included.
        let assistant = messages[1]["content"] as! [[String: Any]]
        XCTAssertEqual(assistant[0]["type"] as? String, "thinking")
    }

    func testBatchHaltsAtFirstFailure() async throws {
        let transport = ScriptedTransport([
            response([toolUse("a", "left_click", ["coordinate": [1, 1]]),
                      toolUse("b", "type", ["text": "x"]),
                      toolUse("c", "screenshot")], stop: "tool_use"),
            response([["type": "text", "text": "Hmm."]], stop: "end_turn"),
        ])
        let backend = FakeBackend()
        backend.failOn = { if case .click = $0 { return true } else { return false } }
        let agent = ComputerAgent(transport: transport, backend: backend)

        _ = try await agent.run(userText: "go")

        XCTAssertEqual(backend.performed.count, 1, "later actions in the batch must not run")
        let messages = transport.requests[1]["messages"] as! [[String: Any]]
        let results = messages[2]["content"] as! [[String: Any]]
        XCTAssertEqual(results.count, 3)
        XCTAssertTrue(results.allSatisfy { $0["is_error"] as? Bool == true })
        XCTAssertTrue(results.allSatisfy { $0["toolset_name"] as? String == "computer" })
    }

    func testUnknownToolIsAnErrorResult() async throws {
        let transport = ScriptedTransport([
            response([["type": "tool_use", "id": "x", "name": "bash", "input": ["command": "ls"]]], stop: "tool_use"),
            response([["type": "text", "text": "Okay."]], stop: "end_turn"),
        ])
        let backend = FakeBackend()
        let agent = ComputerAgent(transport: transport, backend: backend)
        _ = try await agent.run(userText: "go")
        XCTAssertTrue(backend.performed.isEmpty)
        let results = (transport.requests[1]["messages"] as! [[String: Any]])[2]["content"] as! [[String: Any]]
        XCTAssertEqual(results[0]["is_error"] as? Bool, true)
    }

    func testFollowUpKeepsConversation() async throws {
        let transport = ScriptedTransport([
            response([["type": "text", "text": "Which one?"]], stop: "end_turn"),
            response([["type": "text", "text": "Got it."]], stop: "end_turn"),
        ])
        let agent = ComputerAgent(transport: transport, backend: FakeBackend())
        _ = try await agent.run(userText: "open the file")
        _ = try await agent.run(userText: "the second one")
        let messages = transport.requests[1]["messages"] as! [[String: Any]]
        XCTAssertEqual(messages.count, 3)
        agent.reset()
        XCTAssertEqual(agent.messageCount, 0)
    }

    func testBetaFeaturesDroppedAfter400() async throws {
        let transport = ScriptedTransport([
            .failure(AgentError.api(status: 400, type: "invalid_request_error", message: "unknown beta")),
            response([["type": "text", "text": "Hi."]], stop: "end_turn"),
        ])
        let agent = ComputerAgent(transport: transport, backend: FakeBackend())
        let outcome = try await agent.run(userText: "hello")
        XCTAssertEqual(outcome, .reply("Hi."))
        XCTAssertEqual(transport.betaHeaders[0].count, 2)
        XCTAssertTrue(transport.betaHeaders[1].isEmpty)
        XCTAssertNil(transport.requests[1]["fallbacks"])
        XCTAssertNil(transport.requests[1]["thinking"])
        XCTAssertFalse(agent.config.useBetaFeatures)
    }

    func testOtherErrorsPropagate() async {
        let transport = ScriptedTransport([
            .failure(AgentError.api(status: 401, type: "authentication_error", message: "bad key")),
        ])
        let agent = ComputerAgent(transport: transport, backend: FakeBackend())
        do {
            _ = try await agent.run(userText: "hello")
            XCTFail("expected an error")
        } catch AgentError.api(let status, _, _) {
            XCTAssertEqual(status, 401)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testCancelledRunLeavesValidHistory() async throws {
        let transport = ScriptedTransport([
            response([toolUse("t1", "screenshot")], stop: "tool_use"),
        ])
        let backend = CancellingBackend()
        let agent = ComputerAgent(transport: transport, backend: backend)
        do {
            _ = try await agent.run(userText: "go")
            XCTFail("expected cancellation")
        } catch is CancellationError {}
        // user, assistant(tool_use), user(tool_result error): every tool_use is answered.
        let (body, _) = try agent.buildRequest()
        let messages = (try JSONSerialization.jsonObject(with: body) as! [String: Any])["messages"] as! [[String: Any]]
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["user", "assistant", "user"])
        let result = (messages[2]["content"] as! [[String: Any]])[0]
        XCTAssertEqual(result["tool_use_id"] as? String, "t1")
        XCTAssertEqual(result["is_error"] as? Bool, true)
    }

    func testStepLimit() async throws {
        let loop = (0..<5).map { _ in response([toolUse("t", "screenshot")], stop: "tool_use") }
        var config = AgentConfig()
        config.maxSteps = 3
        let agent = ComputerAgent(transport: ScriptedTransport(loop), backend: FakeBackend(), config: config)
        let outcome = try await agent.run(userText: "go")
        XCTAssertEqual(outcome, .stepLimit)
    }

    func testRefusal() async throws {
        let transport = ScriptedTransport([
            .success(["content": [], "stop_reason": "refusal", "stop_details": ["type": "refusal", "category": "cyber", "explanation": "Declined."]]),
        ])
        let agent = ComputerAgent(transport: transport, backend: FakeBackend())
        let outcome = try await agent.run(userText: "x")
        XCTAssertEqual(outcome, .refused("Declined."))
    }
}

final class CancellingBackend: ComputerBackend {
    func perform(_ action: ComputerAction) async throws -> ActionOutput { throw CancellationError() }
}
