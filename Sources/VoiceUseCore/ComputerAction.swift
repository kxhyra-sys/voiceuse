import Foundation

public struct Point: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

public enum Modifier: String, CaseIterable, Sendable {
    case shift, control, option, command
}

public enum ClickKind: Sendable {
    case left, right, middle, double, triple
}

public enum ScrollDirection: String, Sendable {
    case up, down, left, right
}

/// One action from the `computer_toolset_20260801` toolset, with coordinates still in
/// screenshot-pixel space (the backend maps them to screen points).
public enum ComputerAction: Equatable, Sendable {
    case screenshot
    case zoom(from: Point, to: Point)
    case click(ClickKind, at: Point?, modifiers: [Modifier])
    case drag(from: Point, to: Point, modifiers: [Modifier])
    case mouseMove(Point)
    case mouseDown
    case mouseUp
    case cursorPosition
    case scroll(ScrollDirection, amount: Int, at: Point?, modifiers: [Modifier])
    case type(String)
    case key(KeyCombo, repeatCount: Int)
    case holdKey(KeyCombo, seconds: Double)
    case wait(seconds: Double)

    /// Short phrase for the HUD, e.g. "clicking (640, 60)".
    public var summary: String {
        func p(_ pt: Point?) -> String { pt.map { "(\(Int($0.x)), \(Int($0.y)))" } ?? "here" }
        switch self {
        case .screenshot: return "looking at the screen"
        case .zoom: return "zooming in"
        case .click(let kind, let at, _):
            switch kind {
            case .left: return "clicking \(p(at))"
            case .right: return "right-clicking \(p(at))"
            case .middle: return "middle-clicking \(p(at))"
            case .double: return "double-clicking \(p(at))"
            case .triple: return "triple-clicking \(p(at))"
            }
        case .drag(let from, let to, _): return "dragging \(p(from)) to \(p(to))"
        case .mouseMove(let pt): return "moving to \(p(pt))"
        case .mouseDown: return "pressing the mouse"
        case .mouseUp: return "releasing the mouse"
        case .cursorPosition: return "checking the cursor"
        case .scroll(let dir, _, _, _): return "scrolling \(dir.rawValue)"
        case .type(let text): return "typing \"\(text.count > 28 ? String(text.prefix(28)) + "…" : text)\""
        case .key(let combo, _): return "pressing \(combo.display)"
        case .holdKey(let combo, _): return "holding \(combo.display)"
        case .wait(let s): return "waiting \(Int(s))s"
        }
    }
}

public enum ActionParseError: Error, Equatable, CustomStringConvertible {
    case unknownTool(String)
    case badInput(String)

    public var description: String {
        switch self {
        case .unknownTool(let name): return "Unknown computer action '\(name)'."
        case .badInput(let why): return why
        }
    }
}

extension ComputerAction {
    /// Parses a `tool_use` block from the computer toolset. The action is the block's `name`.
    public static func parse(name: String, input: [String: Any]) throws -> ComputerAction {
        func point(_ key: String) throws -> Point {
            guard let p = optionalPoint(key) else {
                throw ActionParseError.badInput("'\(name)' needs '\(key)' as [x, y].")
            }
            return p
        }
        func optionalPoint(_ key: String) -> Point? {
            guard let raw = input[key] as? [Any], raw.count == 2,
                  let x = number(raw[0]), let y = number(raw[1]) else { return nil }
            return Point(x, y)
        }
        func mods() -> [Modifier] {
            guard let text = input["text"] as? String, !text.isEmpty else { return [] }
            return (try? KeyParser.parse(text).modifiers) ?? []
        }

        switch name {
        case "screenshot":
            return .screenshot
        case "zoom":
            guard let raw = input["region"] as? [Any], raw.count == 4,
                  let x0 = number(raw[0]), let y0 = number(raw[1]),
                  let x1 = number(raw[2]), let y1 = number(raw[3]) else {
                throw ActionParseError.badInput("'zoom' needs 'region' as [x0, y0, x1, y1].")
            }
            return .zoom(from: Point(min(x0, x1), min(y0, y1)), to: Point(max(x0, x1), max(y0, y1)))
        case "left_click": return .click(.left, at: optionalPoint("coordinate"), modifiers: mods())
        case "right_click": return .click(.right, at: optionalPoint("coordinate"), modifiers: mods())
        case "middle_click": return .click(.middle, at: optionalPoint("coordinate"), modifiers: mods())
        case "double_click": return .click(.double, at: optionalPoint("coordinate"), modifiers: mods())
        case "triple_click": return .click(.triple, at: optionalPoint("coordinate"), modifiers: mods())
        case "left_click_drag":
            return .drag(from: try point("start_coordinate"), to: try point("coordinate"), modifiers: mods())
        case "mouse_move":
            return .mouseMove(try point("coordinate"))
        case "left_mouse_down": return .mouseDown
        case "left_mouse_up": return .mouseUp
        case "cursor_position": return .cursorPosition
        case "scroll":
            guard let dirText = input["scroll_direction"] as? String,
                  let dir = ScrollDirection(rawValue: dirText) else {
                throw ActionParseError.badInput("'scroll' needs 'scroll_direction' of up, down, left or right.")
            }
            let amount = Int(number(input["scroll_amount"] as Any) ?? 3)
            return .scroll(dir, amount: max(1, min(amount, 100)), at: optionalPoint("coordinate"), modifiers: mods())
        case "type":
            guard let text = input["text"] as? String else {
                throw ActionParseError.badInput("'type' needs 'text'.")
            }
            return .type(text)
        case "key":
            guard let text = input["text"] as? String, !text.isEmpty else {
                throw ActionParseError.badInput("'key' needs 'text', e.g. \"Return\" or \"super+c\".")
            }
            let repeats = Int(number(input["repeat"] as Any) ?? 1)
            return .key(try KeyParser.parse(text), repeatCount: max(1, min(repeats, 100)))
        case "hold_key":
            guard let text = input["text"] as? String, !text.isEmpty else {
                throw ActionParseError.badInput("'hold_key' needs 'text'.")
            }
            let seconds = number(input["duration"] as Any) ?? 1
            return .holdKey(try KeyParser.parse(text), seconds: max(0, min(seconds, 300)))
        case "wait":
            let seconds = number(input["duration"] as Any) ?? 1
            return .wait(seconds: max(0, min(seconds, 300)))
        default:
            throw ActionParseError.unknownTool(name)
        }
    }

    private static func number(_ any: Any) -> Double? {
        if let n = any as? NSNumber { return n.doubleValue }
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        return nil
    }
}
