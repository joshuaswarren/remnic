import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

/// Parsed flags for `ocr-window`: `[--frontmost | --window <id>]`.
/// `windowId == nil` targets the frontmost application's front window.
struct OCRWindowOptions {
    let windowId: CGWindowID?

    static func parse(_ arguments: [String]) throws -> OCRWindowOptions {
        var windowId: CGWindowID?
        var frontmost = false
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--frontmost":
                frontmost = true
            case "--window":
                index += 1
                guard index < arguments.count, let value = UInt32(arguments[index]) else {
                    throw HelperError(message: "--window requires a numeric window id", exitCode: 2)
                }
                windowId = value
            default:
                throw HelperError(message: "unknown argument: \(argument)", exitCode: 2)
            }
            index += 1
        }

        if windowId != nil, frontmost {
            throw HelperError(message: "--window and --frontmost are mutually exclusive", exitCode: 2)
        }

        return OCRWindowOptions(windowId: windowId)
    }
}

/// `ocr-window` payload: `{"app","windowTitle","text","textSource":"ocr"}`.
struct OCRWindowResult: Codable {
    let app: String
    let windowTitle: String
    let text: String
    let textSource: String

    init(app: String, windowTitle: String, text: String) {
        self.app = app
        self.windowTitle = windowTitle
        self.text = text
        self.textSource = "ocr"
    }

    func jsonLine() throws -> Data {
        var line = try JSONEncoder().encode(self)
        line.append(0x0A)
        return line
    }
}

enum OCRWindowReader {
    private struct TargetWindow {
        let windowId: CGWindowID
        let app: String
        let windowTitle: String
    }

    static func recognize(options: OCRWindowOptions) async throws -> OCRWindowResult {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(
                message: "Screen Recording permission required — grant remnic-capture-helper access in "
                    + "System Settings > Privacy & Security > Screen Recording",
                exitCode: 3
            )
        }

        let target = try resolveWindow(options: options)
        // The captured image lives only for the duration of recognition and is
        // never written to disk.
        let image = try await captureImage(windowId: target.windowId)
        let text = try recognizeText(in: image)
        return OCRWindowResult(app: target.app, windowTitle: target.windowTitle, text: text)
    }

    private static func resolveWindow(options: OCRWindowOptions) throws -> TargetWindow {
        let listOption: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infoList = CGWindowListCopyWindowInfo(listOption, kCGNullWindowID) as? [[String: Any]] else {
            throw HelperError(message: "unable to enumerate windows", exitCode: 1)
        }

        if let windowId = options.windowId {
            guard let info = infoList.first(where: { ($0[kCGWindowNumber as String] as? CGWindowID) == windowId }) else {
                throw HelperError(message: "window \(windowId) not found", exitCode: 1)
            }
            return target(from: info, fallbackId: windowId)
        }

        guard let front = NSWorkspace.shared.frontmostApplication else {
            throw HelperError(message: "no frontmost application", exitCode: 1)
        }
        let pid = front.processIdentifier
        let candidate = infoList.first { info in
            (info[kCGWindowOwnerPID as String] as? pid_t) == pid
                && (info[kCGWindowLayer as String] as? Int) == 0
        }
        guard let info = candidate, let windowId = info[kCGWindowNumber as String] as? CGWindowID else {
            throw HelperError(message: "frontmost application has no capturable window", exitCode: 1)
        }
        return target(from: info, fallbackId: windowId)
    }

    private static func target(from info: [String: Any], fallbackId: CGWindowID) -> TargetWindow {
        let windowId = (info[kCGWindowNumber as String] as? CGWindowID) ?? fallbackId
        let app = (info[kCGWindowOwnerName as String] as? String) ?? "unknown app"
        let title = (info[kCGWindowName as String] as? String) ?? ""
        return TargetWindow(windowId: windowId, app: app, windowTitle: title)
    }

    private static func captureImage(windowId: CGWindowID) async throws -> CGImage {
        if #available(macOS 14.0, *) {
            if let image = try? await captureWithScreenCaptureKit(windowId: windowId) {
                return image
            }
        }
        guard let image = captureWithCoreGraphics(windowId: windowId) else {
            throw HelperError(message: "unable to capture window image", exitCode: 1)
        }
        return image
    }

    @available(macOS 14.0, *)
    private static func captureWithScreenCaptureKit(windowId: CGWindowID) async throws -> CGImage {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            throw HelperError(message: "window \(windowId) not shareable", exitCode: 1)
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width))
        configuration.height = max(1, Int(window.frame.height))
        configuration.scalesToFit = true
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    private static func captureWithCoreGraphics(windowId: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowId,
            [.boundsIgnoreFraming, .bestResolution]
        )
    }

    private static func recognizeText(in image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        guard let observations = request.results else { return "" }
        // Reading order: top-to-bottom (Vision's normalized boundingBox origin is
        // bottom-left, so a larger y is higher on screen), then left-to-right.
        return observations
            .sorted { lhs, rhs in
                if abs(lhs.boundingBox.origin.y - rhs.boundingBox.origin.y) > 0.01 {
                    return lhs.boundingBox.origin.y > rhs.boundingBox.origin.y
                }
                return lhs.boundingBox.origin.x < rhs.boundingBox.origin.x
            }
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n")
    }
}
