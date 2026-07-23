import XCTest
@testable import RemnicCaptureHelper

final class ChunkEventTests: XCTestCase {
    func testEncodesACompletedMicChunkAsOneJsonLine() throws {
        let event = ChunkEvent(
            path: "/tmp/remnic-audio/mic-1.wav",
            channel: .mic,
            startedAtUtc: Date(timeIntervalSince1970: 0),
            endedAtUtc: Date(timeIntervalSince1970: 30),
            device: "Built-in Microphone"
        )

        let json = try event.jsonLine()

        XCTAssertEqual(json.last, 0x0A)
        let object = try JSONSerialization.jsonObject(with: json.dropLast()) as? [String: String]
        XCTAssertEqual(
            object,
            [
                "path": "/tmp/remnic-audio/mic-1.wav",
                "channel": "mic",
                "startedAtUtc": "1970-01-01T00:00:00.000Z",
                "endedAtUtc": "1970-01-01T00:00:30.000Z",
                "device": "Built-in Microphone",
            ]
        )
    }
}
