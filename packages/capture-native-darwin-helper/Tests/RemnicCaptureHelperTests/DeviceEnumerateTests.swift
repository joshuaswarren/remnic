import XCTest
@testable import RemnicCaptureHelper

final class DeviceEnumerateTests: XCTestCase {
    func testEncodesDeviceListAsOneJsonLine() throws {
        let list = DeviceList(devices: [
            DeviceInfo(id: "BuiltInMic", name: "MacBook Pro Microphone", kind: .input, isDefault: true),
            DeviceInfo(id: "BuiltInSpeaker", name: "MacBook Pro Speakers", kind: .output, isDefault: false),
        ])

        let json = try list.jsonLine()

        XCTAssertEqual(json.last, 0x0A)
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: Any]
        let devices = try XCTUnwrap(object?["devices"] as? [[String: Any]])
        XCTAssertEqual(devices.count, 2)
        XCTAssertEqual(devices[0]["id"] as? String, "BuiltInMic")
        XCTAssertEqual(devices[0]["name"] as? String, "MacBook Pro Microphone")
        XCTAssertEqual(devices[0]["kind"] as? String, "input")
        XCTAssertEqual(devices[0]["isDefault"] as? Bool, true)
        XCTAssertEqual(devices[1]["kind"] as? String, "output")
        XCTAssertEqual(devices[1]["isDefault"] as? Bool, false)
    }

    func testEncodesEmptyDeviceList() throws {
        let json = try DeviceList(devices: []).jsonLine()
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: Any]
        XCTAssertEqual((object?["devices"] as? [[String: Any]])?.count, 0)
    }
}
