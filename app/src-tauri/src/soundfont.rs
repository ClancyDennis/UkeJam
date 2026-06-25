//! SoundFont resolution + download.
//!
//! We deliberately do NOT bundle a SoundFont: the General MIDI banks that sound
//! good are either proprietary (e.g. Roland SC-55 rips) or large. Instead we
//! resolve one from disk at runtime, and when none is found the frontend offers
//! to download a freely-licensed bank (GeneralUser GS, License v2.0 — permits
//! redistribution and commercial use) into the app data dir.
//!
//! Resolution order (first existing path wins):
//!   1. `UKEJAM_SOUNDFONT` env var — explicit per-machine override
//!   2. `<app_data_dir>/soundfont.sf2` — where `download_soundfont` writes
//!   3. Well-known system locations (Linux distro soundfont packages)

use std::io::Read;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Direct link to a redistributable GM bank (~30 MB). The GeneralUser GS
/// License v2.0 explicitly allows hosting/redistributing copies like this.
const DOWNLOAD_URL: &str =
    "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2";

/// Common locations where Linux distros install a GM SoundFont.
const SYSTEM_PATHS: &[&str] = &[
    "/usr/share/sounds/sf2/FluidR3_GM.sf2",
    "/usr/share/sounds/sf2/default-GM.sf2",
    "/usr/share/soundfonts/FluidR3_GM.sf2",
    "/usr/share/soundfonts/default.sf2",
];

/// The app-data file `download_soundfont` writes and `resolve_path` prefers.
fn data_dir_soundfont(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("soundfont.sf2"))
}

/// Resolve a usable SoundFont path, or `None` if the user has not installed one.
pub fn resolve_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("UKEJAM_SOUNDFONT") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = data_dir_soundfont(app) {
        if p.is_file() {
            return Some(p);
        }
    }
    SYSTEM_PATHS
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

#[derive(Serialize, Clone)]
pub struct SoundfontInfo {
    /// Whether a SoundFont is currently resolvable.
    pub installed: bool,
    /// The resolved SoundFont path (when `installed`).
    pub path: Option<String>,
    /// The app data dir where the user can drop their own `soundfont.sf2`.
    pub data_dir: String,
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    received: u64,
    /// Total bytes from Content-Length, or 0 if the server didn't send it.
    total: u64,
}

#[tauri::command]
pub fn soundfont_status(app: AppHandle) -> SoundfontInfo {
    let resolved = resolve_path(&app);
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    SoundfontInfo {
        installed: resolved.is_some(),
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        data_dir,
    }
}

/// Download the default free SoundFont into the app data dir, emitting
/// `soundfont_progress` events as it streams. Returns the final path on success.
/// Downloads to a `.part` temp file and renames on completion so a partial file
/// is never mistaken for a usable SoundFont.
#[tauri::command]
pub fn download_soundfont(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    let final_path = dir.join("soundfont.sf2");
    let part_path = dir.join("soundfont.sf2.part");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut resp = client
        .get(DOWNLOAD_URL)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download returned {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    // Stream to the temp file; clean it up on any error.
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&part_path)
            .map_err(|e| format!("create soundfont file: {e}"))?;
        let mut buf = [0u8; 64 * 1024];
        let mut received: u64 = 0;
        let mut since_emit: u64 = 0;
        loop {
            let n = resp
                .read(&mut buf)
                .map_err(|e| format!("read while downloading: {e}"))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n])
                .map_err(|e| format!("write soundfont: {e}"))?;
            received += n as u64;
            since_emit += n as u64;
            if since_emit >= 256 * 1024 {
                since_emit = 0;
                let _ = app.emit("soundfont_progress", DownloadProgress { received, total });
            }
        }
        let _ = app.emit("soundfont_progress", DownloadProgress { received, total });
        Ok(())
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&part_path);
        return Err(e);
    }

    std::fs::rename(&part_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&part_path);
        format!("finalize soundfont: {e}")
    })?;
    Ok(final_path.to_string_lossy().into_owned())
}

/// Open the app data dir in the OS file manager so the user can drop in their
/// own `soundfont.sf2`. Done from Rust (via the opener plugin) to sidestep
/// per-path JS capability scoping.
#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("open folder: {e}"))
}
