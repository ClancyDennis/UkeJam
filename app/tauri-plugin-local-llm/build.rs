// Generates the per-command permission files, links the iOS Swift package, and on
// macOS compiles the on-device model helper binary (macos/) that `desktop.rs`
// spawns.
//
// The helper build is BEST EFFORT. A machine without the macOS 26 SDK, or any
// non-macOS desktop target, simply doesn't get it: the `localllm_helper` cfg stays
// unset and `desktop.rs` keeps its "unsupportedHost" behaviour. A missing on-device
// model must never fail the whole app build.
use std::path::PathBuf;
use std::process::Command;

const COMMANDS: &[&str] = &["availability", "chat"];

fn build_macos_helper() -> Option<PathBuf> {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return None;
    }
    // Opt-out for CI or a machine with an older SDK.
    if std::env::var("UKEJAM_SKIP_LOCALLLM_HELPER").is_ok() {
        println!("cargo:warning=local-llm helper skipped (UKEJAM_SKIP_LOCALLLM_HELPER)");
        return None;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").ok()?);
    let package = manifest.join("macos");
    if !package.join("Package.swift").exists() {
        return None;
    }
    // Build into OUT_DIR so the artifact follows the cargo target dir rather
    // than littering the source tree.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").ok()?);
    let scratch = out_dir.join("localllm-helper");
    let status = Command::new("swift")
        .args(["build", "-c", "release", "--package-path"])
        .arg(&package)
        .arg("--scratch-path")
        .arg(&scratch)
        .status();
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => {
            println!("cargo:warning=local-llm helper build failed ({status}); on-device AI will report unsupportedHost");
            return None;
        }
        Err(error) => {
            println!("cargo:warning=could not run swift build ({error}); on-device AI will report unsupportedHost");
            return None;
        }
    }
    // `swift build --show-bin-path` is the supported way to locate the product.
    let bin_path = Command::new("swift")
        .args(["build", "-c", "release", "--package-path"])
        .arg(&package)
        .arg("--scratch-path")
        .arg(&scratch)
        .arg("--show-bin-path")
        .output()
        .ok()?;
    let dir = PathBuf::from(String::from_utf8(bin_path.stdout).ok()?.trim());
    let binary = dir.join("ukejam-localllm-helper");
    binary.exists().then_some(binary)
}

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();

    println!("cargo:rerun-if-changed=macos/Package.swift");
    println!("cargo:rerun-if-changed=macos/Sources");
    println!("cargo:rerun-if-env-changed=UKEJAM_SKIP_LOCALLLM_HELPER");
    // Declare the cfg so a modern rustc doesn't warn about an unexpected name.
    println!("cargo:rustc-check-cfg=cfg(localllm_helper)");

    if let Some(binary) = build_macos_helper() {
        println!("cargo:rustc-env=LOCALLLM_HELPER_BIN={}", binary.display());
        println!("cargo:rustc-cfg=localllm_helper");
    }
}
