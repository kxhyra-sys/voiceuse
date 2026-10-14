import XCTest
@testable import VoiceUseCore

final class ActionAndGeometryTests: XCTestCase {
    func testParseClickWithModifier() throws {
        let action = try ComputerAction.parse(name: "left_click", input: ["coordinate": [640, 60], "text": "shift"])
        XCTAssertEqual(action, .click(.left, at: Point(640, 60), modifiers: [.shift]))
    }

    func testClickWithoutCoordinateUsesCursor() throws {
        XCTAssertEqual(try ComputerAction.parse(name: "double_click", input: [:]),
                       .click(.double, at: nil, modifiers: []))
    }

    func testParseDragScrollTypeKey() throws {
        XCTAssertEqual(
            try ComputerAction.parse(name: "left_click_drag", input: ["start_coordinate": [1, 2], "coordinate": [30.5, 40]]),
            .drag(from: Point(1, 2), to: Point(30.5, 40), modifiers: []))
        XCTAssertEqual(
            try ComputerAction.parse(name: "scroll", input: ["scroll_direction": "down", "scroll_amount": 5, "coordinate": [10, 10]]),
            .scroll(.down, amount: 5, at: Point(10, 10), modifiers: []))
        XCTAssertEqual(try ComputerAction.parse(name: "type", input: ["text": "hi\n"]), .type("hi\n"))
        XCTAssertEqual(try ComputerAction.parse(name: "key", input: ["text": "super+c", "repeat": 2]),
                       .key(try KeyParser.parse("super+c"), repeatCount: 2))
    }

    func testParseZoomNormalizesCorners() throws {
        XCTAssertEqual(try ComputerAction.parse(name: "zoom", input: ["region": [100, 200, 10, 20]]),
                       .zoom(from: Point(10, 20), to: Point(100, 200)))
    }

    func testBadInputAndUnknownTool() {
        XCTAssertThrowsError(try ComputerAction.parse(name: "mouse_move", input: [:]))
        XCTAssertThrowsError(try ComputerAction.parse(name: "scroll", input: ["scroll_direction": "sideways"]))
        XCTAssertThrowsError(try ComputerAction.parse(name: "launch_missiles", input: [:])) { error in
            XCTAssertEqual(error as? ActionParseError, .unknownTool("launch_missiles"))
        }
    }

    func testFitMatchesDocumentedExample() {
        // Docs: a 1512×982 screen limited to 1568px long edge / 1.15MP.
        let fitted = ScreenGeometry.fit(width: 1512, height: 982, maxLongEdge: 1568, maxPixels: 1_150_000)
        XCTAssertEqual(fitted.width, 1330)
        XCTAssertEqual(fitted.height, 864)
        XCTAssertLessThanOrEqual(fitted.width * fitted.height, 1_150_000)
    }

    func testFitNeverUpscales() {
        let fitted = ScreenGeometry.fit(width: 800, height: 600, maxLongEdge: 1568, maxPixels: 1_150_000)
        XCTAssertEqual(fitted.width, 800)
        XCTAssertEqual(fitted.height, 600)
    }

    func testScaleRoundTripAndClamp() {
        let scale = ScreenScale(screenWidth: 1512, screenHeight: 982)
        let screen = scale.toScreen(Point(Double(scale.shotWidth) / 2, Double(scale.shotHeight) / 2))
        XCTAssertEqual(screen.x, 756, accuracy: 0.5)
        XCTAssertEqual(screen.y, 491, accuracy: 0.5)

        let back = scale.toShot(Point(756, 491))
        XCTAssertEqual(back.x, Double(scale.shotWidth) / 2, accuracy: 0.5)

        let clamped = scale.toScreen(Point(99_999, -50))
        XCTAssertEqual(clamped.x, 1511)
        XCTAssertEqual(clamped.y, 0)
    }
}
