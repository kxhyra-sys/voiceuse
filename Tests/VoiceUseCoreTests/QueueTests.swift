import AppKit
import XCTest
@testable import VoiceUseCore

final class PageClassifierTests: XCTestCase {
    private let queueLines = [
        "Borussia Dortmund", "Du befindest dich im Warteraum",
        "Deine voraussichtliche Wartezeit beträgt ca. 12 Minuten",
        "Status zuletzt aktualisiert: 12:04:31",
    ]

    func testQueuePage() {
        guard case .queue(let wait) = PageClassifier.classify(lines: queueLines) else {
            return XCTFail("expected queue")
        }
        XCTAssertEqual(wait?.minutes, 12)
    }

    func testShopPage() {
        let lines = ["BVB - SV Elversberg", "Platzauswahl", "Kategorie 2", "Block 11", "In den Warenkorb"]
        XCTAssertEqual(PageClassifier.classify(lines: lines), .shop)
    }

    func testOneShopWordIsNotEnough() {
        XCTAssertEqual(PageClassifier.classify(lines: ["Willkommen", "Warenkorb"]), .unknown)
    }

    func testHandoffPages() {
        XCTAssertEqual(PageClassifier.classify(lines: ["Bitte bestätige: Ich bin kein Roboter"]), .captcha)
        XCTAssertEqual(PageClassifier.classify(lines: ["Zahlungsart wählen", "Kostenpflichtig bestellen"]), .payment)
        XCTAssertEqual(PageClassifier.classify(lines: ["E-Mail", "Passwort", "Anmelden"]), .login)
    }

    func testCaptchaBeatsQueueText() {
        XCTAssertEqual(PageClassifier.classify(lines: ["Wartezeit", "I'm not a robot"]), .captcha)
    }

    func testWaitParsing() {
        XCTAssertEqual(PageClassifier.parseWait(text: "ca. 12 Minuten")?.minutes, 12)
        XCTAssertEqual(PageClassifier.parseWait(text: "etwa 5-10 Minuten")?.minutes, 10)
        XCTAssertEqual(PageClassifier.parseWait(text: "mehr als 1 Stunde")?.minutes, 60)
        XCTAssertEqual(PageClassifier.parseWait(text: "1 Stunde 20 Minuten")?.minutes, 80)
        XCTAssertEqual(PageClassifier.parseWait(text: "weniger als eine Minute")?.minutes, 0)
        XCTAssertEqual(PageClassifier.parseWait(text: "ca. 45 min")?.minutes, 45)
        XCTAssertNil(PageClassifier.parseWait(text: "bald")?.minutes)
    }

    func testWaitSplitAcrossLines() {
        let wait = PageClassifier.parseWait(lines: ["Deine voraussichtliche Wartezeit", "beträgt ca. 7 Minuten", "Status zuletzt"])
        XCTAssertEqual(wait?.minutes, 7)
    }
}

final class QueueTrackerTests: XCTestCase {
    private func queue(_ minutes: Int) -> Observation {
        .page(.queue(WaitEstimate(minutes: minutes, text: "ca. \(minutes) Minuten")), lineCount: 5)
    }
    private let shop = Observation.page(.shop, lineCount: 20)

    func testEnterUpdatePass() {
        let tracker = QueueTracker()
        XCTAssertEqual(tracker.ingest(queue(12)), [.entered(WaitEstimate(minutes: 12, text: "ca. 12 Minuten"))])
        XCTAssertTrue(tracker.ingest(queue(12)).isEmpty, "same wait is not an update")
        XCTAssertEqual(tracker.ingest(queue(10)), [.updated(WaitEstimate(minutes: 10, text: "ca. 10 Minuten"))])
        XCTAssertTrue(tracker.ingest(shop).isEmpty, "needs two confirmations")
        XCTAssertEqual(tracker.ingest(shop), [.passed(.shop)])
        XCTAssertTrue(tracker.ingest(shop).isEmpty, "passes only once")
    }

    func testUnrecognisedPageStillCountsAsThrough() {
        let tracker = QueueTracker()
        _ = tracker.ingest(queue(3))
        _ = tracker.ingest(.page(.unknown, lineCount: 12))
        XCTAssertEqual(tracker.ingest(.page(.unknown, lineCount: 12)), [.passed(.unknown)])
    }

    func testBlipDoesNotTriggerPass() {
        let tracker = QueueTracker()
        _ = tracker.ingest(queue(3))
        XCTAssertTrue(tracker.ingest(shop).isEmpty)
        XCTAssertTrue(tracker.ingest(queue(3)).isEmpty, "queue text came back, count resets")
        XCTAssertTrue(tracker.ingest(shop).isEmpty)
        XCTAssertEqual(tracker.ingest(shop), [.passed(.shop)])
    }

    func testEmptyReadIsIgnored() {
        let tracker = QueueTracker()
        _ = tracker.ingest(queue(3))
        for _ in 0..<5 { XCTAssertTrue(tracker.ingest(.page(.unknown, lineCount: 0)).isEmpty) }
        XCTAssertTrue(tracker.isInQueue)
    }

    func testNothingFiresBeforeTheQueueWasSeen() {
        let tracker = QueueTracker()
        for _ in 0..<5 { XCTAssertTrue(tracker.ingest(shop).isEmpty) }
    }

    func testLostAndRegainedSight() {
        let tracker = QueueTracker(blindAfter: 3)
        _ = tracker.ingest(queue(3))
        XCTAssertTrue(tracker.ingest(.noWindow).isEmpty)
        XCTAssertTrue(tracker.ingest(.noWindow).isEmpty)
        XCTAssertEqual(tracker.ingest(.noWindow), [.lostSight])
        XCTAssertTrue(tracker.ingest(.noWindow).isEmpty, "only once")
        XCTAssertEqual(tracker.ingest(queue(3)), [.regainedSight])
        XCTAssertTrue(tracker.isInQueue, "place in the queue is kept across a blind spell")
    }

    func testNeedsHumanAfterQueue() {
        let tracker = QueueTracker()
        _ = tracker.ingest(queue(1))
        _ = tracker.ingest(shop)
        XCTAssertEqual(tracker.ingest(shop), [.passed(.shop)])
        XCTAssertEqual(tracker.ingest(.page(.captcha, lineCount: 4)), [.needsHuman(.captcha)])
        XCTAssertTrue(tracker.ingest(.page(.captcha, lineCount: 4)).isEmpty, "once per transition")
        XCTAssertTrue(tracker.ingest(shop).isEmpty)
        XCTAssertEqual(tracker.ingest(.page(.payment, lineCount: 6)), [.needsHuman(.payment)])
    }

    func testPassedOntoCaptchaReportsHandoffOnce() {
        let tracker = QueueTracker()
        _ = tracker.ingest(queue(1))
        _ = tracker.ingest(.page(.captcha, lineCount: 4))
        XCTAssertEqual(tracker.ingest(.page(.captcha, lineCount: 4)), [.passed(.captcha)])
        XCTAssertTrue(tracker.ingest(.page(.captcha, lineCount: 4)).isEmpty)
    }
}

final class OCRTests: XCTestCase {
    /// Renders German waiting-room text to an image and reads it back through Vision.
    func testOCRReadsRenderedQueuePage() throws {
        let image = try render(lines: [
            "Du befindest dich im Warteraum",
            "Deine voraussichtliche Wartezeit beträgt ca. 12 Minuten",
            "Status zuletzt aktualisiert: 12:04:31",
        ])
        let lines = try TextRecognizer.lines(in: image)
        XCTAssertFalse(lines.isEmpty, "OCR returned nothing")
        guard case .queue(let wait) = PageClassifier.classify(lines: lines) else {
            return XCTFail("not recognised as queue: \(lines)")
        }
        XCTAssertEqual(wait?.minutes, 12, "OCR lines: \(lines)")
    }

    func testOCRReadsRenderedShopPage() throws {
        let image = try render(lines: ["Platzauswahl", "Block 11 · Kategorie 2", "In den Warenkorb"])
        XCTAssertEqual(PageClassifier.classify(lines: try TextRecognizer.lines(in: image)), .shop)
    }

    private func render(lines: [String]) throws -> CGImage {
        let size = NSSize(width: 1200, height: 100 + lines.count * 90)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.white.setFill()
        NSRect(origin: .zero, size: size).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 40), .foregroundColor: NSColor.black,
        ]
        for (i, line) in lines.enumerated() {
            line.draw(at: NSPoint(x: 40, y: size.height - CGFloat(80 + i * 90)), withAttributes: attributes)
        }
        image.unlockFocus()
        var rect = NSRect(origin: .zero, size: size)
        return try XCTUnwrap(image.cgImage(forProposedRect: &rect, context: nil, hints: nil))
    }
}
