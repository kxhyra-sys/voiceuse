import AppKit
import CoreGraphics
import VoiceUseCore

/// Posts synthetic mouse and keyboard events. Needs the Accessibility permission.
final class InputController {
    private let source = CGEventSource(stateID: .hidSystemState)
    private var mouseIsDown = false

    func cursorLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    // MARK: Mouse

    func move(to point: CGPoint) {
        postMouse(mouseIsDown ? .leftMouseDragged : .mouseMoved, at: point, button: .left)
    }

    func click(_ kind: ClickKind, at point: CGPoint?, modifiers: [Modifier]) async throws {
        let target = point ?? cursorLocation()
        let flags = cgFlags(modifiers)
        let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = {
            switch kind {
            case .right: return (.rightMouseDown, .rightMouseUp, .right)
            case .middle: return (.otherMouseDown, .otherMouseUp, .center)
            default: return (.leftMouseDown, .leftMouseUp, .left)
            }
        }()
        let count = kind == .double ? 2 : (kind == .triple ? 3 : 1)

        move(to: target)
        try await pause(0.05)
        for i in 1...count {
            postMouse(down, at: target, button: button, clickState: Int64(i), flags: flags)
            try await pause(0.02)
            postMouse(up, at: target, button: button, clickState: Int64(i), flags: flags)
            try await pause(0.03)
        }
    }

    func drag(from: CGPoint, to: CGPoint, modifiers: [Modifier]) async throws {
        let flags = cgFlags(modifiers)
        move(to: from)
        try await pause(0.05)
        postMouse(.leftMouseDown, at: from, button: .left, flags: flags)
        mouseIsDown = true
        defer { if mouseIsDown { releaseMouse() } }
        try await pause(0.08)
        let steps = 14
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            postMouse(.leftMouseDragged, at: p, button: .left, flags: flags)
            try await pause(0.012)
        }
        try await pause(0.05)
        postMouse(.leftMouseUp, at: to, button: .left, flags: flags)
        mouseIsDown = false
    }

    func mouseDown() {
        postMouse(.leftMouseDown, at: cursorLocation(), button: .left)
        mouseIsDown = true
    }

    func mouseUp() {
        postMouse(.leftMouseUp, at: cursorLocation(), button: .left)
        mouseIsDown = false
    }

    /// Lets go of a held button. Called when a run is cancelled mid-drag.
    func releaseMouse() {
        guard mouseIsDown else { return }
        postMouse(.leftMouseUp, at: cursorLocation(), button: .left)
        mouseIsDown = false
    }

    func scroll(_ direction: ScrollDirection, amount: Int, at point: CGPoint?, modifiers: [Modifier]) async throws {
        if let point { move(to: point); try await pause(0.05) }
        let flags = cgFlags(modifiers)
        let perTick: Int32 = 90
        for _ in 0..<amount {
            var dy: Int32 = 0, dx: Int32 = 0
            switch direction {
            case .up: dy = perTick
            case .down: dy = -perTick
            case .left: dx = perTick
            case .right: dx = -perTick
            }
            if let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                   wheel1: dy, wheel2: dx, wheel3: 0) {
                event.flags = flags
                event.post(tap: .cghidEventTap)
            }
            try await pause(0.012)
        }
    }

    // MARK: Keyboard

    func type(_ text: String) async throws {
        for character in text {
            try Task.checkCancellation()
            if character == "\n" || character == "\r" {
                try await press(KeyCombo(keyCode: 36, modifiers: [], display: "Return"), repeatCount: 1)
                continue
            }
            if character == "\t" {
                try await press(KeyCombo(keyCode: 48, modifiers: [], display: "Tab"), repeatCount: 1)
                continue
            }
            let units = Array(String(character).utf16)
            for isDown in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown) else { continue }
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.flags = []
                event.post(tap: .cghidEventTap)
            }
            try await pause(0.008)
        }
    }

    func press(_ combo: KeyCombo, repeatCount: Int) async throws {
        let flags = cgFlags(combo.modifiers)
        for _ in 0..<repeatCount {
            try Task.checkCancellation()
            if let code = combo.keyCode {
                postKey(code, down: true, flags: flags)
                try await pause(0.012)
                postKey(code, down: false, flags: flags)
            } else {
                for mod in combo.modifiers { postKey(KeyParser.keyCode(for: mod), down: true, flags: flags) }
                try await pause(0.012)
                for mod in combo.modifiers.reversed() { postKey(KeyParser.keyCode(for: mod), down: false, flags: []) }
            }
            try await pause(0.02)
        }
    }

    func hold(_ combo: KeyCombo, seconds: Double) async throws {
        let flags = cgFlags(combo.modifiers)
        let codes: [UInt16] = combo.keyCode.map { [$0] } ?? combo.modifiers.map(KeyParser.keyCode(for:))
        for code in codes { postKey(code, down: true, flags: flags) }
        defer { for code in codes.reversed() { postKey(code, down: false, flags: []) } }
        try await pause(seconds)
    }

    // MARK: Helpers

    private func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton,
                           clickState: Int64 = 1, flags: CGEventFlags = []) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    private func postKey(_ code: UInt16, down: Bool, flags: CGEventFlags) {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else { return }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    private func cgFlags(_ modifiers: [Modifier]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod {
            case .shift: flags.insert(.maskShift)
            case .control: flags.insert(.maskControl)
            case .option: flags.insert(.maskAlternate)
            case .command: flags.insert(.maskCommand)
            }
        }
        return flags
    }

    private func pause(_ seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}
