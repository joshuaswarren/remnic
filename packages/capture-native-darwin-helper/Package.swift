// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "RemnicAudioHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "remnic-audio-helper", targets: ["RemnicAudioHelper"]),
    ],
    targets: [
        .executableTarget(name: "RemnicAudioHelper"),
        .testTarget(name: "RemnicAudioHelperTests", dependencies: ["RemnicAudioHelper"]),
    ]
)
