import Foundation

public struct WaitEstimate: Equatable, Sendable {
    /// Upper bound in minutes, when the page states one. 0 means "under a minute".
    public let minutes: Int?
    /// The sentence as read from the page.
    public let text: String

    public init(minutes: Int?, text: String) {
        self.minutes = minutes
        self.text = text
    }

    public var display: String {
        guard let minutes else { return text }
        if minutes == 0 { return "under 1 min" }
        if minutes >= 60 { return "about \(minutes / 60) h \(minutes % 60 > 0 ? "\(minutes % 60) min" : "")".trimmingCharacters(in: .whitespaces) }
        return "about \(minutes) min"
    }
}

public enum PageState: Equatable, Sendable {
    case queue(WaitEstimate?)
    /// Past the waiting room: seat map, category pick, basket.
    case shop
    /// Pages the human must handle.
    case captcha
    case login
    case payment
    case unknown

    public var needsHuman: Bool {
        switch self {
        case .captcha, .login, .payment: return true
        default: return false
        }
    }

    public var label: String {
        switch self {
        case .queue: return "waiting room"
        case .shop: return "shop"
        case .captcha: return "CAPTCHA"
        case .login: return "login"
        case .payment: return "payment"
        case .unknown: return "unknown page"
        }
    }
}

/// Classifies a page from the text OCR read off it. German and English markers.
/// Priority when several match: CAPTCHA > payment > login > waiting room > shop.
public enum PageClassifier {
    public static func classify(lines: [String]) -> PageState {
        let lower = lines.map { $0.lowercased() }
        let text = lower.joined(separator: "\n")
        func has(_ needles: [String]) -> Bool { needles.contains { text.contains($0) } }

        if has(captchaMarkers) { return .captcha }
        if has(paymentMarkers) { return .payment }
        if has(loginMarkers) { return .login }
        if has(queueMarkers) { return .queue(parseWait(lines: lines)) }

        let shopHits = shopMarkers.filter { text.contains($0) }.count
        if shopHits >= 2 { return .shop }
        return .unknown
    }

    private static let captchaMarkers = [
        "ich bin kein roboter", "i'm not a robot", "i am not a robot", "captcha",
        "sicherheitsüberprüfung", "sicherheitsabfrage", "verify you are human", "bestätige, dass du ein mensch",
        "bestätigen sie, dass sie ein mensch", "human verification",
    ]

    private static let paymentMarkers = [
        "kostenpflichtig bestellen", "kartennummer", "card number", "cvc", "cvv", "kartenprüfnummer",
        "zahlungsart wählen", "zahlungsart auswählen", "iban", "place order", "pay now",
    ]

    private static let loginMarkers = [
        "passwort", "password", "kennwort", "zwei-faktor", "two-factor", "2fa",
        "bestätigungscode", "verification code", "sicherheitscode", "einmalcode",
    ]

    private static let queueMarkers = [
        "wartezeit", "warteraum", "warteschlange", "status zuletzt aktualisiert",
        "estimated wait", "waiting room", "you are in line", "you are in the queue",
    ]

    private static let shopMarkers = [
        "platzauswahl", "sitzplan", "saalplan", "areaplan", "warenkorb", "kategorie", "stehplatz",
        "sitzplatz", "tickets auswählen", "in den warenkorb", "block ", "ticketanzahl", "anzahl tickets",
        "select seats", "add to cart", "basket",
    ]

    // MARK: Wait time

    /// Reads the wait from the line that mentions "Wartezeit" plus the two lines after it,
    /// since OCR often splits the sentence.
    public static func parseWait(lines: [String]) -> WaitEstimate? {
        let keys = ["wartezeit", "estimated wait", "warteschlange"]
        guard let index = lines.firstIndex(where: { line in keys.contains { line.lowercased().contains($0) } }) else {
            return nil
        }
        let window = lines[index..<min(index + 3, lines.count)].joined(separator: " ")
        return parseWait(text: window)
    }

    public static func parseWait(text: String) -> WaitEstimate? {
        let cleaned = text.replacingOccurrences(of: "\u{00A0}", with: " ")
        let lower = cleaned.lowercased()
        var minutes: Int?

        if lower.contains("weniger als eine minute") || lower.contains("unter einer minute")
            || lower.contains("less than a minute") || lower.contains("less than one minute") {
            minutes = 0
        } else if let hm = firstMatch(#"(\d+)\s*(?:stunden?|std\.?|hours?|h)\s*(?:und\s*)?(\d+)\s*(?:minuten?|min\.?|minutes?)"#, in: lower),
                  let h = Int(hm[0]), let m = Int(hm[1]) {
            minutes = h * 60 + m
        } else if let range = firstMatch(#"(\d+)\s*(?:-|–|—|bis|to)\s*(\d+)\s*(?:minuten?|min\.?|minutes?)"#, in: lower),
                  let upper = Int(range[1]) {
            minutes = upper
        } else if let m = firstMatch(#"(\d+)\s*(?:minuten?|min\.?|minutes?)"#, in: lower), let value = Int(m[0]) {
            minutes = value
        } else if let h = firstMatch(#"(\d+)\s*(?:stunden?|std\.?|hours?)"#, in: lower), let value = Int(h[0]) {
            minutes = value * 60
        } else if lower.contains("eine stunde") || lower.contains("one hour") {
            minutes = 60
        } else if lower.contains("eine minute") || lower.contains("one minute") {
            minutes = 1
        }

        let sentence = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard minutes != nil || !sentence.isEmpty else { return nil }
        return WaitEstimate(minutes: minutes, text: String(sentence.prefix(120)))
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).compactMap { i in
            Range(match.range(at: i), in: text).map { String(text[$0]) }
        }
    }
}
