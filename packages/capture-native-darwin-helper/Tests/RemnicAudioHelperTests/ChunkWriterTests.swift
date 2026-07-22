import AVFoundation
import XCTest
@testable import RemnicAudioHelper

final class ChunkWriterTests: XCTestCase {
    func testFinishesMicChunkAs16KhzMonoWav() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000)!
        buffer.frameLength = 16_000

        let writer = try ChunkWriter(
            spoolDirectory: directory,
            channel: .mic,
            device: "Built-in Microphone",
            chunkSeconds: 30
        )
        _ = writer.append(buffer, at: Date(timeIntervalSince1970: 0))
        let event = try writer.finish(at: Date(timeIntervalSince1970: 1))

        XCTAssertEqual(event.channel, .mic)
        XCTAssertEqual(event.device, "Built-in Microphone")
        XCTAssertEqual(event.startedAtUtc, Date(timeIntervalSince1970: 0))
        XCTAssertEqual(event.endedAtUtc, Date(timeIntervalSince1970: 1))
        let attributes = try FileManager.default.attributesOfItem(atPath: event.path)
        XCTAssertEqual(URL(fileURLWithPath: event.path).pathExtension, "wav")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: event.path)).prefix(4), Data("RIFF".utf8))
        XCTAssertEqual((attributes[.size] as? NSNumber)?.intValue ?? 0 > 44, true)
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: event.path))
        XCTAssertEqual(file.processingFormat.sampleRate, 16_000)
        XCTAssertEqual(file.processingFormat.channelCount, 1)
    }

    func testReturnsCompletedChunkWhenNewAudioCrossesChunkBoundary() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000)!
        buffer.frameLength = 16_000
        let writer = try ChunkWriter(
            spoolDirectory: directory,
            channel: .system,
            device: "system audio",
            chunkSeconds: 30
        )

        XCTAssertNil(writer.append(buffer, at: Date(timeIntervalSince1970: 0)))
        let completed = writer.append(buffer, at: Date(timeIntervalSince1970: 30))

        XCTAssertEqual(completed?.channel, .system)
        XCTAssertEqual(completed?.startedAtUtc, Date(timeIntervalSince1970: 0))
        XCTAssertEqual(completed?.endedAtUtc, Date(timeIntervalSince1970: 30))
    }
}
