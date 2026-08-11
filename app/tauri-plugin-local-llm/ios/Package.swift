// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-local-llm",
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-local-llm",
            type: .static,
            targets: ["tauri-plugin-local-llm"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-local-llm",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
