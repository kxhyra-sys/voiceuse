// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoiceUse",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "VoiceUse", targets: ["VoiceUse"]),
    ],
    targets: [
        // Platform-neutral logic: agent loop, tool parsing, key names, screen scaling.
        .target(
            name: "VoiceUseCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The macOS menu-bar app: speech, screen capture, input injection, hotkeys, UI.
        .executableTarget(
            name: "VoiceUse",
            dependencies: ["VoiceUseCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "VoiceUseCoreTests",
            dependencies: ["VoiceUseCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
