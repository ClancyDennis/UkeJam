fn main() {
    // AVAudioSession (ios_audio.rs) lives in AVFoundation; the objc runtime
    // only finds the class if the framework is linked into the binary.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
    }
    tauri_build::build()
}
