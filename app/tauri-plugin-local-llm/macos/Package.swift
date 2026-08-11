// swift-tools-version:5.9
import PackageDescription

// A standalone helper binary that exposes Apple's on-device Foundation model over
// a newline-delimited JSON protocol on stdin/stdout. `src/desktop.rs` spawns it.
//
// Why a subprocess rather than linking Swift into the Rust plugin: FoundationModels
// is a Swift-only, async framework, and bridging it through a C ABI would mean
// hand-rolling an async runtime bridge for no benefit. A crash in the model host
// also cannot take the app down with it.
//
// This package deliberately does NOT depend on Tauri — unlike ../ios, which needs
// the generated tauri-api package.
let package = Package(
    name: "ukejam-localllm-helper",
    platforms: [
        // String form rather than `.v26`, which needs swift-tools-version 6.2.
        .macOS("26.0"),
    ],
    products: [
        .executable(name: "ukejam-localllm-helper", targets: ["ukejam-localllm-helper"]),
    ],
    targets: [
        .executableTarget(
            name: "ukejam-localllm-helper",
            path: "Sources/helper"
        ),
    ]
)
