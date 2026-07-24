import Foundation

enum CaptureChannel: String, Codable {
    case mic
    case system
}

struct ChunkEvent: Codable {
    let path: String
    let channel: CaptureChannel
    let startedAtUtc: Date
    let endedAtUtc: Date
    let device: String

    func jsonLine() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Self.timestampFormatter.string(from: date))
        }
        var line = try encoder.encode(self)
        line.append(0x0A)
        return line
    }

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
