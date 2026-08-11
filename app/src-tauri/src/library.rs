//! Song-library persistence: a JSON file in the app data dir.
//!
//! The frontend originally kept the library in webview localStorage, which has
//! a ~5 MB quota (inline base64 MIDIs blow past it) and, on iOS, can be
//! evicted by the OS under disk pressure. The webview still owns the record
//! shape — Rust only stores the JSON bytes durably and atomically.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir.join("library.json"))
}

/// The stored library JSON, or `None` if nothing has been saved yet (the
/// frontend then migrates any pre-existing localStorage library).
#[tauri::command]
pub fn library_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = library_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read library: {e}")),
    }
}

/// Write-then-rename so a crash mid-write can never corrupt the library.
#[tauri::command]
pub fn library_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = library_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write library: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("finalize library: {e}")
    })?;
    Ok(())
}
