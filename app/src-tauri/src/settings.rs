//! App settings persisted as `settings.json` in the app data dir.
//!
//! This holds the instrument tuning and the ✨ AI enhance endpoint. The
//! compiled-in default is the
//! local dev proxy at localhost:4000, which is fine on desktop but meaningless
//! on a phone — there is no localhost proxy on an iPhone — so the Setup screen
//! lets the user point at any reachable OpenAI-compatible endpoint instead.
//! The `UKEJAM_PROXY_URL` / `UKEJAM_PROXY_KEY` env vars still override saved
//! values at request time (see `enhance::resolve_proxy`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    /// OpenAI-compatible chat-completions URL for AI enhance ("" = default).
    #[serde(default)]
    pub proxy_url: String,
    /// Bearer key sent to that endpoint ("" = default dev key).
    #[serde(default)]
    pub proxy_key: String,
    /// Model used for live practice coaching ("" = compiled-in default).
    /// Separate from tab enhancement's model because the two calls have very
    /// different shapes: enhancement is one long offline conversion, coaching is
    /// a short turn the player is waiting on mid-song.
    #[serde(default)]
    pub coach_model: String,
    /// Instrument tuning: "standard" (G-C-E-A) or "baritone" (D-G-B-E).
    /// Empty/absent means standard — the tuning most ukuleles ship with.
    #[serde(default)]
    pub tuning: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Load saved settings; any missing/broken file just yields defaults.
pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load(&app)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("encode: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write settings: {e}"))?;
    Ok(())
}
