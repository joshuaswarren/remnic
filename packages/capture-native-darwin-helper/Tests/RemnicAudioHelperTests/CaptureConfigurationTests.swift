import XCTest
@testable import RemnicAudioHelper

final class CaptureConfigurationTests: XCTestCase {
    func testParsesRequiredSpoolDirectoryAndOptionalChunkSeconds() throws {
        let configuration = try CaptureConfiguration.parse([
            "--spool-dir", "/tmp/remnic-audio",
            "--chunk-seconds", "45",
        ])

        XCTAssertEqual(configuration.spoolDirectory.path, "/tmp/remnic-audio")
        XCTAssertEqual(configuration.chunkSeconds, 45)
    }

    func testRejectsNonPositiveChunkSeconds() {
        XCTAssertThrowsError(
            try CaptureConfiguration.parse(["--spool-dir", "/tmp/remnic-audio", "--chunk-seconds", "0"])
        ) { error in
            XCTAssertEqual(error.localizedDescription, "--chunk-seconds must be a positive integer")
        }
    }

    func testRejectsMissingSpoolDirectory() {
        XCTAssertThrowsError(try CaptureConfiguration.parse([])) { error in
            XCTAssertEqual(error.localizedDescription, "--spool-dir is required")
        }
    }
}
