import XCTest
@testable import RemnicCaptureHelper

final class CaptureConfigurationTests: XCTestCase {
    func testParsesChannelOutChunkSecondsAndDevice() throws {
        let configuration = try CaptureConfiguration.parse([
            "--channel", "both",
            "--chunk-seconds", "45",
            "--out", "/tmp/remnic-audio",
            "--device", "BuiltInMicrophoneDevice",
        ])

        XCTAssertEqual(configuration.channel, .both)
        XCTAssertTrue(configuration.channel.capturesMic)
        XCTAssertTrue(configuration.channel.capturesSystem)
        XCTAssertEqual(configuration.chunkSeconds, 45)
        XCTAssertEqual(configuration.outDirectory.path, "/tmp/remnic-audio")
        XCTAssertEqual(configuration.deviceId, "BuiltInMicrophoneDevice")
    }

    func testDefaultsChunkSecondsAndOmitsDevice() throws {
        let configuration = try CaptureConfiguration.parse([
            "--channel", "mic",
            "--out", "/tmp/remnic-audio",
        ])

        XCTAssertEqual(configuration.channel, .mic)
        XCTAssertTrue(configuration.channel.capturesMic)
        XCTAssertFalse(configuration.channel.capturesSystem)
        XCTAssertEqual(configuration.chunkSeconds, 30)
        XCTAssertNil(configuration.deviceId)
    }

    func testSystemChannelCapturesSystemOnly() throws {
        let configuration = try CaptureConfiguration.parse(["--channel", "system", "--out", "/tmp/x"])

        XCTAssertFalse(configuration.channel.capturesMic)
        XCTAssertTrue(configuration.channel.capturesSystem)
    }

    func testRejectsNonPositiveChunkSeconds() {
        XCTAssertThrowsError(
            try CaptureConfiguration.parse(["--channel", "mic", "--out", "/tmp/x", "--chunk-seconds", "0"])
        ) { error in
            XCTAssertEqual(error.localizedDescription, "--chunk-seconds must be a positive integer")
        }
    }

    func testRejectsInvalidChannel() {
        XCTAssertThrowsError(
            try CaptureConfiguration.parse(["--channel", "sideband", "--out", "/tmp/x"])
        ) { error in
            XCTAssertEqual(error.localizedDescription, "--channel must be mic|system|both, got: sideband")
        }
    }

    func testRejectsMissingChannel() {
        XCTAssertThrowsError(try CaptureConfiguration.parse(["--out", "/tmp/x"])) { error in
            XCTAssertEqual(error.localizedDescription, "--channel is required (mic|system|both)")
        }
    }

    func testRejectsMissingOutDirectory() {
        XCTAssertThrowsError(try CaptureConfiguration.parse(["--channel", "mic"])) { error in
            XCTAssertEqual(error.localizedDescription, "--out is required")
        }
    }

    func testRejectsFlagWithoutValue() {
        XCTAssertThrowsError(try CaptureConfiguration.parse(["--channel"])) { error in
            XCTAssertEqual(error.localizedDescription, "--channel requires a value")
        }
    }

    func testRejectsUnknownArgument() {
        XCTAssertThrowsError(
            try CaptureConfiguration.parse(["--channel", "mic", "--out", "/tmp/x", "--bogus"])
        ) { error in
            XCTAssertEqual(error.localizedDescription, "unknown argument: --bogus")
        }
    }
}
