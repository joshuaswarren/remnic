// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "RemnicCaptureHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "remnic-capture-helper", targets: ["RemnicCaptureHelper"]),
    ],
    targets: [
        .executableTarget(name: "RemnicCaptureHelper"),
        .testTarget(name: "RemnicCaptureHelperTests", dependencies: ["RemnicCaptureHelper"]),
    ]
)
