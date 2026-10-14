import Foundation

public enum AgentError: Error, CustomStringConvertible {
    case missingAPIKey
    case api(status: Int, type: String, message: String)
    case badResponse(String)

    public var description: String {
        switch self {
        case .missingAPIKey:
            return "No Anthropic API key. Choose Set API Key from the VoiceUse menu."
        case .api(let status, let type, let message):
            switch status {
            case 401: return "Anthropic rejected the API key (\(message))."
            case 403: return "This API key is not allowed to use that model (\(message))."
            case 429: return "Rate limited by Anthropic. Try again in a moment."
            case 529: return "Anthropic is overloaded. Try again in a moment."
            default: return "Anthropic API error \(status) \(type): \(message)"
            }
        case .badResponse(let why):
            return "Unexpected response from Anthropic: \(why)"
        }
    }
}

/// Sends one Messages API request body and returns the raw response body.
public protocol MessagesTransport: AnyObject {
    func send(body: Data, betas: [String]) async throws -> Data
}

/// Real transport over HTTPS. Retries rate limits, overloads and 5xx with backoff.
public final class URLSessionTransport: MessagesTransport {
    private let apiKey: () -> String?
    private let session: URLSession
    private let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!

    public init(apiKey: @escaping () -> String?) {
        self.apiKey = apiKey
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 300
        self.session = URLSession(configuration: config)
    }

    public func send(body: Data, betas: [String]) async throws -> Data {
        guard let key = apiKey(), !key.isEmpty else { throw AgentError.missingAPIKey }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if !betas.isEmpty {
            request.setValue(betas.joined(separator: ","), forHTTPHeaderField: "anthropic-beta")
        }

        var attempt = 0
        while true {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AgentError.badResponse("not an HTTP response")
            }
            if (200..<300).contains(http.statusCode) { return data }

            let retryable = http.statusCode == 429 || http.statusCode == 529 || http.statusCode >= 500
            if retryable && attempt < 3 {
                attempt += 1
                let headerDelay = http.value(forHTTPHeaderField: "retry-after").flatMap(Double.init)
                let delay = min(headerDelay ?? Double(1 << attempt), 20)
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                continue
            }
            throw Self.apiError(status: http.statusCode, data: data)
        }
    }

    static func apiError(status: Int, data: Data) -> AgentError {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = object?["error"] as? [String: Any]
        return .api(status: status,
                    type: error?["type"] as? String ?? "error",
                    message: error?["message"] as? String ?? String(data: data, encoding: .utf8) ?? "")
    }
}
