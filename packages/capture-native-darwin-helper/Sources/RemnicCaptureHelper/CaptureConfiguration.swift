import Foundation

/// Which capture channels the `audio-capture` subcommand should run.
enum ChannelSelection: String {
    case mic
    case system
    case both

    var capturesMic: Bool { self == .mic || self == .both }
    var capturesSystem: Bool { self == .system || self == .both }
}

/// Parsed flags for `audio-capture`:
/// `--channel mic|system|both --chunk-seconds N --out <dir> [--device <id>]`.
struct CaptureConfiguration {
    let outDirectory: URL
    let chunkSeconds: Int
    let channel: ChannelSelection
    /// Optional CoreAudio device UID selecting a specific microphone input.
    let deviceId: String?

    static func parse(_ arguments: [String]) throws -> CaptureConfiguration {
        var outDirectory: URL?
        var chunkSeconds = 30
        var channel: ChannelSelection?
        var deviceId: String?
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--out":
                outDirectory = URL(fileURLWithPath: try value(arguments, &index, argument))
            case "--chunk-seconds":
                let raw = try value(arguments, &index, argument)
                guard let seconds = Int(raw), seconds > 0 else {
                    throw CaptureConfigurationError.invalidChunkSeconds
                }
                chunkSeconds = seconds
            case "--channel":
                let raw = try value(arguments, &index, argument)
                guard let parsed = ChannelSelection(rawValue: raw) else {
                    throw CaptureConfigurationError.invalidChannel(raw)
                }
                channel = parsed
            case "--device":
                deviceId = try value(arguments, &index, argument)
            default:
                throw CaptureConfigurationError.unknownArgument(argument)
            }
            index += 1
        }

        guard let channel else {
            throw CaptureConfigurationError.missingChannel
        }
        guard let outDirectory else {
            throw CaptureConfigurationError.missingOutDirectory
        }

        return CaptureConfiguration(
            outDirectory: outDirectory,
            chunkSeconds: chunkSeconds,
            channel: channel,
            deviceId: deviceId
        )
    }

    /// Consume the value that follows a flag, advancing the parse index.
    private static func value(_ arguments: [String], _ index: inout Int, _ flag: String) throws -> String {
        index += 1
        guard index < arguments.count else {
            throw CaptureConfigurationError.missingValue(flag)
        }
        return arguments[index]
    }
}

enum CaptureConfigurationError: LocalizedError {
    case missingOutDirectory
    case missingChannel
    case invalidChunkSeconds
    case invalidChannel(String)
    case missingValue(String)
    case unknownArgument(String)

    var errorDescription: String? {
        switch self {
        case .missingOutDirectory:
            "--out is required"
        case .missingChannel:
            "--channel is required (mic|system|both)"
        case .invalidChunkSeconds:
            "--chunk-seconds must be a positive integer"
        case let .invalidChannel(value):
            "--channel must be mic|system|both, got: \(value)"
        case let .missingValue(flag):
            "\(flag) requires a value"
        case let .unknownArgument(argument):
            "unknown argument: \(argument)"
        }
    }
}
