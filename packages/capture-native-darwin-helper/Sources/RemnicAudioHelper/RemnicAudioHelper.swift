import Foundation
import Dispatch

@main
struct RemnicAudioHelper {
    static func main() async {
        do {
            let configuration = try CaptureConfiguration.parse(Array(CommandLine.arguments.dropFirst()))
            let controller = try AudioCaptureController(configuration: configuration)
            try await controller.start()
            await waitForTermination(controller: controller)
        } catch {
            FileHandle.standardError.write(Data("remnic-audio-helper: \(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }

    private static func waitForTermination(controller: AudioCaptureController) async {
        let signal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        Darwin.signal(SIGTERM, SIG_IGN)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            signal.setEventHandler {
                signal.cancel()
                continuation.resume()
            }
            signal.resume()
        }
        await controller.stop()
    }
}
