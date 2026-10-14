import Foundation

/// What one capture of the watched window showed.
public enum Observation: Equatable, Sendable {
    /// The browser window could not be captured (closed, minimized, other Space).
    case noWindow
    /// A capture was read. `lineCount` is how many text lines OCR found.
    case page(PageState, lineCount: Int)
}

public enum QueueEvent: Equatable, Sendable {
    case entered(WaitEstimate?)
    case updated(WaitEstimate?)
    /// The waiting-room text is gone. `state` is what the page shows now.
    case passed(PageState)
    /// After the queue: the page now needs the human (CAPTCHA, login, payment).
    case needsHuman(PageState)
    /// The queue was seen before and the window can no longer be read.
    case lostSight
    case regainedSight
}

/// Turns a stream of observations into events. Tuned so a false alarm is cheaper than a miss:
/// once the waiting-room text has been seen, it disappearing for `passConfirmations` readable
/// captures in a row counts as "through", whatever the new page looks like.
public final class QueueTracker {
    public let passConfirmations: Int
    public let blindAfter: Int

    private var armed = false
    private var afterQueue = false
    private var absentCount = 0
    private var blindCount = 0
    private var blind = false
    private var lastWait: WaitEstimate?
    private var lastHuman: PageState?

    public init(passConfirmations: Int = 2, blindAfter: Int = 6) {
        self.passConfirmations = passConfirmations
        self.blindAfter = blindAfter
    }

    public var isInQueue: Bool { armed }

    public func reset() {
        armed = false
        afterQueue = false
        absentCount = 0
        blindCount = 0
        blind = false
        lastWait = nil
        lastHuman = nil
    }

    public func ingest(_ observation: Observation) -> [QueueEvent] {
        var events: [QueueEvent] = []

        switch observation {
        case .noWindow:
            blindCount += 1
            if (armed || afterQueue) && !blind && blindCount >= blindAfter {
                blind = true
                events.append(.lostSight)
            }
            return events

        case .page(let state, let lineCount):
            blindCount = 0
            if blind {
                blind = false
                events.append(.regainedSight)
            }
            // An empty read is a capture glitch, not a page. Don't let it count as "gone".
            if lineCount == 0 && !isQueue(state) { return events }

            if case .queue(let wait) = state {
                absentCount = 0
                afterQueue = false
                lastHuman = nil
                if !armed {
                    armed = true
                    lastWait = wait
                    events.append(.entered(wait))
                } else if wait != lastWait {
                    lastWait = wait
                    events.append(.updated(wait))
                }
                return events
            }

            if armed {
                absentCount += 1
                if absentCount >= passConfirmations {
                    armed = false
                    afterQueue = true
                    absentCount = 0
                    lastWait = nil
                    lastHuman = state.needsHuman ? state : nil
                    events.append(.passed(state))
                }
                return events
            }

            if afterQueue {
                if state.needsHuman {
                    if lastHuman != state {
                        lastHuman = state
                        events.append(.needsHuman(state))
                    }
                } else {
                    lastHuman = nil
                }
            }
            return events
        }
    }

    private func isQueue(_ state: PageState) -> Bool {
        if case .queue = state { return true }
        return false
    }
}
