import Foundation

/// A key press such as "super+shift+4": an optional main key (macOS virtual key code) plus modifiers.
/// A combo with no `keyCode` is modifiers only, e.g. "shift" for `hold_key`.
public struct KeyCombo: Equatable, Sendable {
    public var keyCode: UInt16?
    public var modifiers: [Modifier]
    public var display: String

    public init(keyCode: UInt16?, modifiers: [Modifier], display: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.display = display
    }
}

public enum KeyParseError: Error, Equatable, CustomStringConvertible {
    case unknownKey(String)
    case empty

    public var description: String {
        switch self {
        case .unknownKey(let k): return "Unknown key '\(k)'. Use names like Return, Tab, Escape, BackSpace, Up, F5, a, super+c."
        case .empty: return "Empty key."
        }
    }
}

/// Parses xdotool-style key names ("ctrl+shift+Delete", "super+c", "Return") into macOS key codes.
public enum KeyParser {
    public static func parse(_ text: String) throws -> KeyCombo {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { throw KeyParseError.empty }

        // "ctrl++" means ctrl and the plus key; a lone "+" is the plus key.
        var tokens = trimmed.components(separatedBy: "+")
        if trimmed == "+" {
            tokens = ["plus"]
        } else if trimmed.hasSuffix("+") && tokens.count >= 2 {
            tokens.removeLast(2)
            tokens.append("plus")
        }

        var modifiers: [Modifier] = []
        var mainKey: String?
        for raw in tokens {
            let token = raw.trimmingCharacters(in: .whitespaces)
            guard !token.isEmpty else { continue }
            if let mod = modifier(for: token) {
                if !modifiers.contains(mod) { modifiers.append(mod) }
            } else {
                mainKey = token
            }
        }

        guard let name = mainKey else {
            guard !modifiers.isEmpty else { throw KeyParseError.empty }
            return KeyCombo(keyCode: nil, modifiers: modifiers, display: trimmed)
        }
        guard let (code, impliedShift) = keyCode(for: name) else {
            throw KeyParseError.unknownKey(name)
        }
        if impliedShift && !modifiers.contains(.shift) { modifiers.append(.shift) }
        return KeyCombo(keyCode: code, modifiers: modifiers, display: trimmed)
    }

    public static func modifier(for token: String) -> Modifier? {
        switch token.lowercased() {
        case "shift", "shift_l", "shift_r": return .shift
        case "ctrl", "control", "ctrl_l", "ctrl_r", "control_l", "control_r": return .control
        case "alt", "option", "opt", "alt_l", "alt_r": return .option
        case "super", "cmd", "command", "meta", "win", "windows", "super_l", "super_r": return .command
        default: return nil
        }
    }

    /// Virtual key code of each modifier's own key (for holding it down).
    public static func keyCode(for modifier: Modifier) -> UInt16 {
        switch modifier {
        case .command: return 55
        case .shift: return 56
        case .option: return 58
        case .control: return 59
        }
    }

    /// Returns the macOS virtual key code, and whether the name implies Shift ("plus", uppercase letters).
    public static func keyCode(for name: String) -> (UInt16, Bool)? {
        if name.count == 1, let scalar = name.unicodeScalars.first,
           scalar.properties.isUppercase, let code = table[name.lowercased()] {
            return (code, true)
        }
        let lower = name.lowercased()
        if let code = table[lower] { return (code, shiftedNames.contains(lower)) }
        return nil
    }

    /// Names for shifted symbols; they share a key code with the unshifted key.
    private static let shiftedNames: Set<String> = [
        "plus", "asterisk", "exclam", "at", "numbersign", "dollar", "percent", "underscore",
    ]

    // ANSI-layout macOS virtual key codes (Carbon kVK_*).
    private static let table: [String: UInt16] = {
        var t: [String: UInt16] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
            "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
            "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
            "equal": 24, "=": 24, "minus": 27, "-": 27,
            "bracketright": 30, "]": 30, "bracketleft": 33, "[": 33,
            "apostrophe": 39, "quote": 39, "'": 39, "semicolon": 41, ";": 41,
            "backslash": 42, "\\": 42, "comma": 43, ",": 43, "slash": 44, "/": 44,
            "period": 47, ".": 47, "grave": 50, "`": 50,
            "return": 36, "enter": 36, "kp_enter": 76, "tab": 48, "space": 49, " ": 49,
            "backspace": 51, "escape": 53, "esc": 53,
            "delete": 117, "forwarddelete": 117,
            "home": 115, "end": 119,
            "page_up": 116, "pageup": 116, "prior": 116,
            "page_down": 121, "pagedown": 121, "next": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
            "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
            "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        ]
        t["plus"] = 24
        t["asterisk"] = 28
        t["exclam"] = 18
        t["at"] = 19
        t["numbersign"] = 20
        t["dollar"] = 21
        t["percent"] = 23
        t["underscore"] = 27
        return t
    }()
}
