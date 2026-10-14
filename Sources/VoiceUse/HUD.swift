import AppKit
import Combine
import SwiftUI

struct HUDView: View {
    @ObservedObject var model: AppModel

    private var icon: String {
        switch model.phase {
        case .listening: return "mic.fill"
        case .working: return "sparkles"
        case .speaking: return "speaker.wave.2.fill"
        case .idle: return model.problem == nil ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch model.phase {
        case .listening: return .red
        case .working: return .blue
        case .speaking: return .green
        case .idle: return model.problem == nil ? .green : .orange
        }
    }

    private var title: String {
        if let problem = model.problem { return problem }
        switch model.phase {
        case .listening: return model.transcript.isEmpty ? "Listening…" : model.transcript
        case .working: return model.note.isEmpty ? "Working…" : model.note
        case .speaking: return model.reply
        case .idle: return model.reply.isEmpty ? model.note : model.reply
        }
    }

    private var subtitle: String? {
        switch model.phase {
        case .listening: return model.transcript.isEmpty ? "Speak now. Pauses send it." : "Pause to send, or press ⌃⌥Space."
        case .working: return model.transcript.isEmpty ? nil : "“\(model.transcript)”   ⌃⌥Space to stop"
        default: return nil
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: 440, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(tint.opacity(0.5), lineWidth: 1))
    }
}

/// A click-through floating panel at the top of the main screen.
@MainActor
final class HUDController {
    private let panel: NSPanel
    private var cancellable: AnyCancellable?

    init(model: AppModel) {
        let host = NSHostingView(rootView: HUDView(model: model))
        host.setFrameSize(host.fittingSize)
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = host
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        cancellable = model.$hudVisible.removeDuplicates().sink { [weak self] visible in
            Task { @MainActor in
                visible ? self?.show() : self?.panel.orderOut(nil)
            }
        }
        // Resize as the content changes.
        host.postsFrameChangedNotifications = true
    }

    private func show() {
        guard let host = panel.contentView else { return }
        let size = host.fittingSize
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 14,
                                  width: size.width, height: size.height), display: true)
        }
        panel.orderFrontRegardless()
    }
}
