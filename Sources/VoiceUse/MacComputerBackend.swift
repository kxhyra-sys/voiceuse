import AppKit
import VoiceUseCore

/// Runs toolset actions on the real Mac: captures the screen and posts input events.
/// Claude's coordinates are screenshot pixels; they are mapped to screen points here.
final class MacComputerBackend: ComputerBackend {
    private let capturer = ScreenCapturer()
    private let input = InputController()

    func perform(_ action: ComputerAction) async throws -> ActionOutput {
        try Task.checkCancellation()
        let scale = capturer.scale
        func screenPoint(_ p: Point) -> CGPoint {
            let s = scale.toScreen(p)
            return CGPoint(x: s.x, y: s.y)
        }

        switch action {
        case .screenshot:
            return .image(try await capturer.screenshot())
        case .zoom(let from, let to):
            return .image(try await capturer.zoom(from: from, to: to))
        case .cursorPosition:
            let p = input.cursorLocation()
            let shot = scale.toShot(Point(p.x, p.y))
            return .text("X=\(Int(shot.x)), Y=\(Int(shot.y))")
        case .wait(let seconds):
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return .text("OK")
        default:
            break
        }

        switch action {
        case .click(let kind, let at, let modifiers):
            try await input.click(kind, at: at.map(screenPoint), modifiers: modifiers)
        case .drag(let from, let to, let modifiers):
            try await input.drag(from: screenPoint(from), to: screenPoint(to), modifiers: modifiers)
        case .mouseMove(let p):
            input.move(to: screenPoint(p))
        case .mouseDown:
            input.mouseDown()
        case .mouseUp:
            input.mouseUp()
        case .scroll(let direction, let amount, let at, let modifiers):
            try await input.scroll(direction, amount: amount, at: at.map(screenPoint), modifiers: modifiers)
        case .type(let text):
            try await input.type(text)
        case .key(let combo, let repeatCount):
            try await input.press(combo, repeatCount: repeatCount)
        case .holdKey(let combo, let seconds):
            try await input.hold(combo, seconds: seconds)
        case .screenshot, .zoom, .cursorPosition, .wait:
            break
        }
        // Give the UI a beat to react before the next action or screenshot.
        try await Task.sleep(nanoseconds: 150_000_000)
        return .text("OK")
    }

    /// Releases anything a cancelled run might have left held down.
    func cleanup() {
        input.releaseMouse()
    }
}
