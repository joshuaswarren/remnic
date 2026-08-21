import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Parsed flags for `ax-snapshot`:
/// `[--frontmost | --pid <n>] [--max-nodes N]`. `pid == nil` targets the
/// frontmost application.
struct AXSnapshotOptions {
    let pid: pid_t?
    let maxNodes: Int

    static func parse(_ arguments: [String]) throws -> AXSnapshotOptions {
        var pid: pid_t?
        var frontmost = false
        var maxNodes = 4000
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--frontmost":
                frontmost = true
            case "--pid":
                index += 1
                guard index < arguments.count, let value = Int32(arguments[index]), value > 0 else {
                    throw HelperError(message: "--pid requires a positive integer", exitCode: 2)
                }
                pid = value
            case "--max-nodes":
                index += 1
                guard index < arguments.count, let value = Int(arguments[index]), value > 0 else {
                    throw HelperError(message: "--max-nodes requires a positive integer", exitCode: 2)
                }
                maxNodes = value
            default:
                throw HelperError(message: "unknown argument: \(argument)", exitCode: 2)
            }
            index += 1
        }

        if pid != nil, frontmost {
            throw HelperError(message: "--pid and --frontmost are mutually exclusive", exitCode: 2)
        }

        return AXSnapshotOptions(pid: pid, maxNodes: maxNodes)
    }
}

/// One accessibility node. Deliberately permissive and RAW — the helper does
/// NOT filter secure/off-screen text; it serializes the tree and the daemon
/// (`@remnic/capture-screen` axtree.ts) applies the security filters, so that
/// logic stays unit-testable off-macOS. Matches the daemon's `AxNode`.
/// A secure-text node is emitted with its role only (never its value/children),
/// as defense-in-depth so a password never leaves the helper.
struct AxNode: Codable {
    let role: String?
    let value: String?
    let title: String?
    let description: String?
    let offScreen: Bool?
    let children: [AxNode]?
}

/// `ax-snapshot` payload: window context + the raw AX tree.
/// `{"app","windowTitle","browserUrl"?,"tree":AxNode}`.
struct AXSnapshotResult: Codable {
    let app: String
    let windowTitle: String
    let browserUrl: String?
    let tree: AxNode

    func jsonLine() throws -> Data {
        // A nil `browserUrl` is omitted (synthesized encodeIfPresent), matching
        // the optional-key contract the daemon expects.
        var line = try JSONEncoder().encode(self)
        line.append(0x0A)
        return line
    }
}

enum AXSnapshotReader {
    static func snapshot(options: AXSnapshotOptions) throws -> AXSnapshotResult {
        guard AXIsProcessTrusted() else {
            throw HelperError(
                message: "Accessibility permission required — grant remnic-capture-helper access in "
                    + "System Settings > Privacy & Security > Accessibility",
                exitCode: 3
            )
        }

        let (pid, appName) = try resolveTarget(options: options)
        let application = AXUIElementCreateApplication(pid)
        let window = try focusedWindow(of: application)
        let windowTitle = string(window, kAXTitleAttribute) ?? ""
        let browserUrl = url(of: window)

        let screenBounds = combinedScreenBounds()
        var visited = 0
        let tree = serialize(window, maxNodes: options.maxNodes, screenBounds: screenBounds, visited: &visited)

        return AXSnapshotResult(app: appName, windowTitle: windowTitle, browserUrl: browserUrl, tree: tree)
    }

    private static func resolveTarget(options: AXSnapshotOptions) throws -> (pid_t, String) {
        if let pid = options.pid {
            let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
            return (pid, name)
        }
        guard let front = NSWorkspace.shared.frontmostApplication else {
            throw HelperError(message: "no frontmost application", exitCode: 1)
        }
        return (front.processIdentifier, front.localizedName ?? "unknown app")
    }

    private static func focusedWindow(of application: AXUIElement) throws -> AXUIElement {
        if let window = element(application, kAXFocusedWindowAttribute) {
            return window
        }
        if let window = element(application, kAXMainWindowAttribute) {
            return window
        }
        if let windows = elements(application, kAXWindowsAttribute), let first = windows.first {
            return first
        }
        throw HelperError(message: "target application has no accessible window", exitCode: 1)
    }

    /// Serialize an element (and, bounded by `maxNodes`, its subtree) into a raw
    /// AxNode. No text filtering here — the daemon does secure/off-screen/cap
    /// filtering on the emitted tree.
    private static func serialize(
        _ element: AXUIElement,
        maxNodes: Int,
        screenBounds: CGRect,
        visited: inout Int
    ) -> AxNode {
        visited += 1

        let role = string(element, kAXRoleAttribute)
        let subrole = string(element, kAXSubroleAttribute)

        // Secure text field (subrole AXSecureTextField): never read its value and
        // never descend — it is a password. Emit the secure role marker only, so
        // the daemon still sees the node exists but no secret leaves the helper.
        if subrole == "AXSecureTextField" {
            return AxNode(role: "AXSecureTextField", value: nil, title: nil, description: nil, offScreen: nil, children: nil)
        }

        let onScreen = isOnScreen(element, within: screenBounds)

        var children: [AxNode]?
        if let kids = elements(element, kAXChildrenAttribute), !kids.isEmpty {
            var out: [AxNode] = []
            for child in kids {
                if visited >= maxNodes { break }
                out.append(serialize(child, maxNodes: maxNodes, screenBounds: screenBounds, visited: &visited))
            }
            if !out.isEmpty { children = out }
        }

        return AxNode(
            role: role,
            value: string(element, kAXValueAttribute),
            title: string(element, kAXTitleAttribute),
            description: string(element, kAXDescriptionAttribute),
            offScreen: onScreen ? nil : true,
            children: children
        )
    }

    // MARK: attribute helpers

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    private static func string(_ element: AXUIElement, _ name: String) -> String? {
        guard let value = attribute(element, name), CFGetTypeID(value) == CFStringGetTypeID() else {
            return nil
        }
        // swiftlint:disable:next force_cast
        return (value as! CFString) as String
    }

    private static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        // swiftlint:disable:next force_cast
        return (value as! AXUIElement)
    }

    private static func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement]? {
        guard let value = attribute(element, name), CFGetTypeID(value) == CFArrayGetTypeID() else {
            return nil
        }
        return value as? [AXUIElement]
    }

    private static func url(of element: AXUIElement) -> String? {
        guard let value = attribute(element, kAXURLAttribute as String) else { return nil }
        if let url = value as? URL {
            return url.absoluteString
        }
        return nil
    }

    private static func isOnScreen(_ element: AXUIElement, within screenBounds: CGRect) -> Bool {
        guard let frame = frame(of: element) else {
            // Position/size unavailable: keep it rather than over-excluding.
            return true
        }
        if frame.width <= 0 || frame.height <= 0 {
            return false
        }
        if screenBounds.isNull || screenBounds.isEmpty {
            return true
        }
        return screenBounds.intersects(frame)
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        guard let positionValue = attribute(element, kAXPositionAttribute),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              let sizeValue = attribute(element, kAXSizeAttribute),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
            return nil
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        // swiftlint:disable force_cast
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
            return nil
        }
        // swiftlint:enable force_cast
        return CGRect(origin: point, size: size)
    }

    /// Union of active display bounds. `CGDisplayBounds` uses the global
    /// top-left origin space, matching `kAXPositionAttribute`.
    private static func combinedScreenBounds() -> CGRect {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return .null }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &displays, &count) == .success else { return .null }
        var bounds = CGRect.null
        for display in displays {
            bounds = bounds.union(CGDisplayBounds(display))
        }
        return bounds
    }
}
