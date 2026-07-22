import AVFoundation
import Foundation

final class ChunkWriter {
    private let spoolDirectory: URL
    private let channel: CaptureChannel
    private let device: String
    private let chunkSeconds: Int
    private let destinationFormat: AVAudioFormat
    private var file: AVAudioFile?
    private var chunkURL: URL?
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var startedAtUtc: Date?

    init(
        spoolDirectory: URL,
        channel: CaptureChannel,
        device: String,
        chunkSeconds: Int
    ) throws {
        self.spoolDirectory = spoolDirectory
        self.channel = channel
        self.device = device
        self.chunkSeconds = chunkSeconds
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        ) else {
            throw ChunkWriterError.unavailableFormat
        }
        destinationFormat = format
        try FileManager.default.createDirectory(at: spoolDirectory, withIntermediateDirectories: true)
    }

    func append(_ buffer: AVAudioPCMBuffer, at timestamp: Date) -> ChunkEvent? {
        var completed: ChunkEvent?
        do {
            if let startedAtUtc, timestamp.timeIntervalSince(startedAtUtc) >= TimeInterval(chunkSeconds) {
                completed = try finish(at: timestamp)
            }
            if file == nil {
                try openChunk(at: timestamp)
            }
            try write(buffer)
        } catch {
            FileHandle.standardError.write(Data("remnic-audio-helper: \(error.localizedDescription)\n".utf8))
        }
        return completed
    }

    func finish(at endedAtUtc: Date) throws -> ChunkEvent {
        guard let chunkURL, let startedAtUtc else {
            throw ChunkWriterError.noOpenChunk
        }
        var completedFile = file
        file = nil
        self.chunkURL = nil
        self.startedAtUtc = nil
        if #available(macOS 15.0, *) {
            completedFile?.close()
        }
        completedFile = nil
        return ChunkEvent(
            path: chunkURL.path,
            channel: channel,
            startedAtUtc: startedAtUtc,
            endedAtUtc: endedAtUtc,
            device: device
        )
    }

    private func openChunk(at timestamp: Date) throws {
        let chunkURL = spoolDirectory.appendingPathComponent("\(channel.rawValue)-\(UUID().uuidString).wav")
        file = try AVAudioFile(
            forWriting: chunkURL,
            settings: destinationFormat.settings,
            commonFormat: .pcmFormatInt16,
            interleaved: true
        )
        self.chunkURL = chunkURL
        startedAtUtc = timestamp
    }

    private func write(_ buffer: AVAudioPCMBuffer) throws {
        guard let file else {
            throw ChunkWriterError.noOpenChunk
        }
        if buffer.format.sampleRate == destinationFormat.sampleRate,
           buffer.format.channelCount == destinationFormat.channelCount,
           buffer.format.commonFormat == destinationFormat.commonFormat {
            try file.write(from: buffer)
            return
        }

        if converter == nil || converterInputFormat?.isEqual(buffer.format) != true {
            converter = AVAudioConverter(from: buffer.format, to: destinationFormat)
            converterInputFormat = buffer.format
        }
        guard let converter else {
            throw ChunkWriterError.unavailableConverter
        }
        let capacity = AVAudioFrameCount(
            ceil(Double(buffer.frameLength) * destinationFormat.sampleRate / buffer.format.sampleRate)
        )
        guard let converted = AVAudioPCMBuffer(pcmFormat: destinationFormat, frameCapacity: capacity) else {
            throw ChunkWriterError.unavailableBuffer
        }
        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            throw conversionError ?? ChunkWriterError.conversionFailed
        }
        try file.write(from: converted)
    }
}

enum ChunkWriterError: LocalizedError {
    case unavailableFormat
    case unavailableConverter
    case unavailableBuffer
    case conversionFailed
    case noOpenChunk

    var errorDescription: String? {
        switch self {
        case .unavailableFormat: "unable to create 16 kHz mono PCM format"
        case .unavailableConverter: "unable to convert captured audio to 16 kHz mono PCM"
        case .unavailableBuffer: "unable to allocate converted audio buffer"
        case .conversionFailed: "audio conversion failed"
        case .noOpenChunk: "no audio chunk is open"
        }
    }
}
