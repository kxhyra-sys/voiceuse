import Carbon.HIToolbox
import Foundation

/// System-wide hotkeys through Carbon's RegisterEventHotKey, which needs no extra permission.
final class HotKeys {
    enum Hotkey: UInt32 {
        case talk = 1   // ⌃⌥Space: start / stop listening, or stop a running task
        case stop = 2   // ⌃⌥⎋: emergency stop
    }

    private var refs: [EventHotKeyRef?] = []
    private var handlerRef: EventHandlerRef?
    var onPress: ((Hotkey) -> Void)?

    private static let signature: OSType = 0x5655_5345 // 'VUSE'

    func register() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let hotkeys = Unmanaged<HotKeys>.fromOpaque(userData).takeUnretainedValue()
            if let key = Hotkey(rawValue: id.id) {
                DispatchQueue.main.async { hotkeys.onPress?(key) }
            }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)

        let modifiers = UInt32(controlKey | optionKey)
        add(.talk, keyCode: UInt32(kVK_Space), modifiers: modifiers)
        add(.stop, keyCode: UInt32(kVK_Escape), modifiers: modifiers)
    }

    private func add(_ key: Hotkey, keyCode: UInt32, modifiers: UInt32) {
        var ref: EventHotKeyRef?
        let id = EventHotKeyID(signature: Self.signature, id: key.rawValue)
        RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
        refs.append(ref)
    }
}
