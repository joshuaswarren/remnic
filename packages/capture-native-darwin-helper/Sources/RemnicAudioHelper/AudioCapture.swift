import AVFoundation
import CoreMedia
import Foundation
import Dispatch
import ScreenCaptureKit

final class AudioCaptureController {
    private let micCapture: MicrophoneCapture
    private let systemCapture: SystemAudioCapture

    init(configuration: CaptureConfiguration) throws {
        micCapture = try MicrophoneCapture(configuration: configuration)
        systemCapture = try SystemAudioCapture(configuration: configuration)
    }

    func start() async throws {
        try micCapture.start()
        do {
            try await systemCapture.start()
        } catch {
            micCapture.stop()
            throw error
        }
    }

    func stop() async {
        micCapture.stop()
        await systemCapture.stop()
    }
}

private final class MicrophoneCapture {
    private let writer: ChunkWriter
    private let engine = AVAudioEngine()

    init(configuration: CaptureConfiguration) throws {
        writer = try ChunkWriter(
            spoolDirectory: configuration.spoolDirectory,
            channel: .mic,
            device: AVCaptureDevice.default(for: .audio)?.localizedName ?? "default microphone",
            chunkSeconds: configuration.chunkSeconds
        )
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [writer] buffer, _ in
            if let event = writer.append(buffer, at: Date()) {
                emit(event)
            }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        finish(writer)
    }
}

private final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: ChunkWriter
    private var stream: SCStream?

    init(configuration: CaptureConfiguration) throws {
        writer = try ChunkWriter(
            spoolDirectory: configuration.spoolDirectory,
            channel: .system,
            device: "system audio",
            chunkSeconds: configuration.chunkSeconds
        )
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            throw AudioCaptureError.noDisplay
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.channelCount = 1
        configuration.sampleRate = 16_000
        configuration.excludesCurrentProcessAudio = false

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        self.stream = nil
        finish(writer)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, sampleBuffer.isValid else {
            return
        }
        withPCMBuffer(from: sampleBuffer) { buffer in
            if let event = writer.append(buffer, at: Date()) {
                emit(event)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("remnic-audio-helper: system audio capture stopped: \(error.localizedDescription)\n".utf8))
    }

    private func withPCMBuffer(from sampleBuffer: CMSampleBuffer, consume: (AVAudioPCMBuffer) -> Void) {
        guard let description = sampleBuffer.formatDescription else {
            return
        }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let list = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { list.deallocate() }
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: list,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list, deallocator: nil) else {
            return
        }
        consume(buffer)
    }
}

private enum AudioCaptureError: LocalizedError {
    case noDisplay

    var errorDescription: String? {
        switch self {
        case .noDisplay: "no display is available for system-audio capture"
        }
    }
}

private func finish(_ writer: ChunkWriter) {
    do {
        emit(try writer.finish(at: Date()))
    } catch ChunkWriterError.noOpenChunk {
    } catch {
        FileHandle.standardError.write(Data("remnic-audio-helper: \(error.localizedDescription)\n".utf8))
    }
}

private let eventOutputQueue = DispatchQueue(label: "com.remnic.audio-helper.event-output")

private func emit(_ event: ChunkEvent) {
    eventOutputQueue.sync {
        do {
            FileHandle.standardOutput.write(try event.jsonLine())
        } catch {
            FileHandle.standardError.write(
                Data("remnic-audio-helper: unable to emit chunk event: \(error.localizedDescription)\n".utf8)
            )
        }
    }
}
