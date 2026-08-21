import XCTest
@testable import RemnicCaptureHelper

final class OCRWindowTests: XCTestCase {
    func testDefaultsToFrontmost() throws {
        let options = try OCRWindowOptions.parse([])
        XCTAssertNil(options.windowId)
    }

    func testParsesWindowId() throws {
        let options = try OCRWindowOptions.parse(["--window", "42"])
        XCTAssertEqual(options.windowId, 42)
    }

    func testFrontmostFlagKeepsWindowIdNil() throws {
        let options = try OCRWindowOptions.parse(["--frontmost"])
        XCTAssertNil(options.windowId)
    }

    func testRejectsWindowAndFrontmostTogether() {
        XCTAssertThrowsError(try OCRWindowOptions.parse(["--window", "42", "--frontmost"]))
    }

    func testRejectsNonNumericWindowId() {
        XCTAssertThrowsError(try OCRWindowOptions.parse(["--window", "abc"]))
    }

    func testRejectsUnknownArgument() {
        XCTAssertThrowsError(try OCRWindowOptions.parse(["--bogus"]))
    }

    func testEncodesResultAsOneJsonLine() throws {
        let result = OCRWindowResult(app: "Notes", windowTitle: "Grocery", text: "milk\neggs")

        let json = try result.jsonLine()
        XCTAssertEqual(json.last, 0x0A)
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: Any]
        XCTAssertEqual(object?["app"] as? String, "Notes")
        XCTAssertEqual(object?["windowTitle"] as? String, "Grocery")
        XCTAssertEqual(object?["text"] as? String, "milk\neggs")
        XCTAssertEqual(object?["textSource"] as? String, "ocr")
    }
}
