import XCTest
@testable import RemnicCaptureHelper

final class AXSnapshotTests: XCTestCase {
    func testDefaultsToFrontmostAndMaxNodes() throws {
        let options = try AXSnapshotOptions.parse([])
        XCTAssertNil(options.pid)
        XCTAssertEqual(options.maxNodes, 4000)
    }

    func testParsesPidAndMaxNodes() throws {
        let options = try AXSnapshotOptions.parse(["--pid", "1234", "--max-nodes", "500"])
        XCTAssertEqual(options.pid, 1234)
        XCTAssertEqual(options.maxNodes, 500)
    }

    func testFrontmostFlagKeepsPidNil() throws {
        let options = try AXSnapshotOptions.parse(["--frontmost", "--max-nodes", "10"])
        XCTAssertNil(options.pid)
        XCTAssertEqual(options.maxNodes, 10)
    }

    func testRejectsPidAndFrontmostTogether() {
        XCTAssertThrowsError(try AXSnapshotOptions.parse(["--pid", "1", "--frontmost"]))
    }

    func testRejectsNonPositivePid() {
        XCTAssertThrowsError(try AXSnapshotOptions.parse(["--pid", "0"]))
    }

    func testRejectsUnknownArgument() {
        XCTAssertThrowsError(try AXSnapshotOptions.parse(["--bogus"]))
    }

    func testEncodesResultWithBrowserUrlAndRawTree() throws {
        let tree = AxNode(
            role: "AXWindow",
            value: nil,
            title: "Example",
            description: nil,
            offScreen: nil,
            children: [
                AxNode(role: "AXStaticText", value: "Hello", title: nil, description: nil, offScreen: nil, children: nil),
                AxNode(role: "AXSecureTextField", value: nil, title: nil, description: nil, offScreen: nil, children: nil),
            ]
        )
        let result = AXSnapshotResult(
            app: "Safari",
            windowTitle: "Example",
            browserUrl: "https://example.com/",
            tree: tree
        )

        let json = try result.jsonLine()
        XCTAssertEqual(json.last, 0x0A)
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: Any]
        XCTAssertEqual(object?["app"] as? String, "Safari")
        XCTAssertEqual(object?["windowTitle"] as? String, "Example")
        XCTAssertEqual(object?["browserUrl"] as? String, "https://example.com/")

        let treeObject = object?["tree"] as? [String: Any]
        XCTAssertEqual(treeObject?["role"] as? String, "AXWindow")
        XCTAssertEqual(treeObject?["title"] as? String, "Example")
        let children = treeObject?["children"] as? [[String: Any]]
        XCTAssertEqual(children?.count, 2)
        XCTAssertEqual(children?[0]["role"] as? String, "AXStaticText")
        XCTAssertEqual(children?[0]["value"] as? String, "Hello")
        // The secure node carries its role only — never a value key.
        XCTAssertEqual(children?[1]["role"] as? String, "AXSecureTextField")
        XCTAssertFalse((children?[1].keys.contains("value")) ?? true)
    }

    func testOmitsBrowserUrlWhenNil() throws {
        let tree = AxNode(role: "AXWindow", value: nil, title: "bash", description: nil, offScreen: nil, children: nil)
        let result = AXSnapshotResult(app: "Terminal", windowTitle: "bash", browserUrl: nil, tree: tree)

        let json = try result.jsonLine()
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: Any]
        XCTAssertFalse(object?.keys.contains("browserUrl") ?? true)
        XCTAssertNotNil(object?["tree"])
    }
}
