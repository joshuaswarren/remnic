import Dispatch
import Foundation

/// Unified Remnic macOS native capture helper.
///
/// One binary serves both the audio-capture pipeline (#1897) and the
/// screen-activity pipeline (#1899). The subcommand is `argv[1]`:
///
///   audio-capture    long-running PCM WAV chunk writer (mic / system / both)
///   device-enumerate one-shot audio device list
///   ax-snapshot      one-shot accessibility text snapshot of a window
///   ocr-window       one-shot Vision OCR of a window image (image never persisted)
///
/// Every one-shot subcommand prints exactly one JSON line to stdout. Missing
/// TCC permissions exit non-zero with a one-line stderr instruction.
@main
struct RemnicCaptureHelper {
    static let programName = "remnic-capture-helper"

    static func main() async {
        // Writing chunk events to a closed stdout pipe must not SIGPIPE-kill the
        // helper before controller.stop()/finish() can flush; ignore it here too.
        Darwin.signal(SIGPIPE, SIG_IGN)
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let subcommand = arguments.first else {
            fail("missing subcommand (audio-capture|device-enumerate|ax-snapshot|ocr-window)", code: 2)
        }
        let rest = Array(arguments.dropFirst())

        do {
            switch subcommand {
            case "audio-capture":
                try await runAudioCapture(rest)
            case "device-enumerate":
                try runDeviceEnumerate(rest)
            case "ax-snapshot":
                try runAxSnapshot(rest)
            case "ocr-window":
                try await runOcrWindow(rest)
            case "--help", "-h", "help":
                printUsage()
            default:
                fail("unknown subcommand: \(subcommand)", code: 2)
            }
        } catch let error as HelperError {
            fail(error.message, code: error.exitCode)
        } catch {
            fail(error.localizedDescription, code: 1)
        }
    }

    // MARK: audio-capture

    private static func runAudioCapture(_ arguments: [String]) async throws {
        let configuration = try CaptureConfiguration.parse(arguments)
        let controller = try AudioCaptureController(configuration: configuration)
        try await controller.start()
        await waitForTermination(controller: controller)
    }

    private static func waitForTermination(controller: AudioCaptureController) async {
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        Darwin.signal(SIGTERM, SIG_IGN)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            source.setEventHandler {
                source.cancel()
                continuation.resume()
            }
            source.resume()
        }
        await controller.stop()
    }

    // MARK: device-enumerate

    private static func runDeviceEnumerate(_ arguments: [String]) throws {
        guard arguments.isEmpty else {
            throw HelperError(message: "device-enumerate takes no arguments", exitCode: 2)
        }
        let list = try DeviceEnumerator.enumerate()
        writeLine(try list.jsonLine())
    }

    // MARK: ax-snapshot

    private static func runAxSnapshot(_ arguments: [String]) throws {
        let options = try AXSnapshotOptions.parse(arguments)
        let result = try AXSnapshotReader.snapshot(options: options)
        writeLine(try result.jsonLine())
    }

    // MARK: ocr-window

    private static func runOcrWindow(_ arguments: [String]) async throws {
        let options = try OCRWindowOptions.parse(arguments)
        let result = try await OCRWindowReader.recognize(options: options)
        writeLine(try result.jsonLine())
    }

    // MARK: output helpers

    private static func printUsage() {
        let usage = """
        usage: \(programName) <subcommand> [options]
          audio-capture --channel mic|system|both --chunk-seconds N --out <dir> [--device <id>]
          device-enumerate
          ax-snapshot [--frontmost | --pid <n>] [--max-nodes N]
          ocr-window [--frontmost | --window <id>]
        """
        FileHandle.standardOutput.write(Data((usage + "\n").utf8))
    }

    private static func writeLine(_ data: Data) {
        FileHandle.standardOutput.write(data)
    }

    private static func fail(_ message: String, code: Int32) -> Never {
        FileHandle.standardError.write(Data("\(programName): \(message)\n".utf8))
        Foundation.exit(code)
    }
}

/// A domain error that carries an explicit process exit code. Missing-TCC
/// failures use this to exit non-zero with a clear one-line message.
struct HelperError: Error {
    let message: String
    let exitCode: Int32
}
