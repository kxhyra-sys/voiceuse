import XCTest
@testable import VoiceUseCore

final class KeyParserTests: XCTestCase {
    func testSingleKeys() throws {
        XCTAssertEqual(try KeyParser.parse("Return").keyCode, 36)
        XCTAssertEqual(try KeyParser.parse("Tab").keyCode, 48)
        XCTAssertEqual(try KeyParser.parse("Escape").keyCode, 53)
        XCTAssertEqual(try KeyParser.parse("BackSpace").keyCode, 51)
        XCTAssertEqual(try KeyParser.parse("Delete").keyCode, 117)
        XCTAssertEqual(try KeyParser.parse("Page_Down").keyCode, 121)
        XCTAssertEqual(try KeyParser.parse("F5").keyCode, 96)
        XCTAssertEqual(try KeyParser.parse("a").keyCode, 0)
        XCTAssertEqual(try KeyParser.parse("space").keyCode, 49)
    }

    func testCombos() throws {
        let copy = try KeyParser.parse("super+c")
        XCTAssertEqual(copy.keyCode, 8)
        XCTAssertEqual(copy.modifiers, [.command])

        let combo = try KeyParser.parse("ctrl+alt+shift+Delete")
        XCTAssertEqual(combo.keyCode, 117)
        XCTAssertEqual(combo.modifiers, [.control, .option, .shift])

        XCTAssertEqual(try KeyParser.parse("cmd+Tab").modifiers, [.command])
        XCTAssertEqual(try KeyParser.parse("Alt+Tab").modifiers, [.option])
    }

    func testPlusKey() throws {
        let plus = try KeyParser.parse("super++")
        XCTAssertEqual(plus.keyCode, 24)
        XCTAssertEqual(plus.modifiers, [.command, .shift])
        XCTAssertEqual(try KeyParser.parse("+").keyCode, 24)
        XCTAssertEqual(try KeyParser.parse("super+plus").modifiers, [.command, .shift])
    }

    func testUppercaseLetterImpliesShift() throws {
        let combo = try KeyParser.parse("A")
        XCTAssertEqual(combo.keyCode, 0)
        XCTAssertEqual(combo.modifiers, [.shift])
    }

    func testModifierOnly() throws {
        let shift = try KeyParser.parse("shift")
        XCTAssertNil(shift.keyCode)
        XCTAssertEqual(shift.modifiers, [.shift])
    }

    func testUnknownKeyThrows() {
        XCTAssertThrowsError(try KeyParser.parse("super+Banana"))
        XCTAssertThrowsError(try KeyParser.parse(""))
    }
}
