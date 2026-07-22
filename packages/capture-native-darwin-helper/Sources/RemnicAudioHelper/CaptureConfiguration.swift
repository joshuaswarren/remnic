import Foundation

struct CaptureConfiguration {
    let spoolDirectory: URL
    let chunkSeconds: Int

    static func parse(_ arguments: [String]) throws -> CaptureConfiguration {
        var spoolDirectory: URL?
        var chunkSeconds = 30
        var index = 0

        while index < arguments.count {
            switch arguments[index] {
            case "--spool-dir":
                index += 1
                guard index < arguments.count else {
                    throw CaptureConfigurationError.missingSpoolDirectory
                }
                spoolDirectory = URL(fileURLWithPath: arguments[index])
            case "--chunk-seconds":
                index += 1
                guard index < arguments.count,
                      let value = Int(arguments[index]),
                      value > 0 else {
                    throw CaptureConfigurationError.invalidChunkSeconds
                }
                chunkSeconds = value
            default:
                throw CaptureConfigurationError.unknownArgument(arguments[index])
            }
            index += 1
        }

        guard let spoolDirectory else {
            throw CaptureConfigurationError.missingSpoolDirectory
        }

        return CaptureConfiguration(spoolDirectory: spoolDirectory, chunkSeconds: chunkSeconds)
    }
}

enum CaptureConfigurationError: LocalizedError {
    case missingSpoolDirectory
    case invalidChunkSeconds
    case unknownArgument(String)

    var errorDescription: String? {
        switch self {
        case .missingSpoolDirectory:
            "--spool-dir is required"
        case .invalidChunkSeconds:
            "--chunk-seconds must be a positive integer"
        case let .unknownArgument(argument):
            "unknown argument: \(argument)"
        }
    }
}
