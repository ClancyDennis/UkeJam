//! App settings persisted as `settings.json` in the app data dir.
//!
//! Today this holds the ✨ AI enhance provider config: which provider to use
//! (Apple Intelligence on-device, OpenRouter, or an OpenAI-compatible
//! endpoint), and the key/model/URL it needs. It lives here rather than in
//! webview `localStorage` for the same reason the song library does: the
//! webview store is evictable under disk pressure on iOS, and losing a saved
//! OpenRouter key silently signs the player out.
//!
//! `UKEJAM_PROXY_URL` / `UKEJAM_PROXY_KEY` still override the saved values at
//! request time for the OpenAI-compatible provider (see `AiConfig::endpoint`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::enhance::AiConfig;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    /// The AI enhance provider config. Absent in files written before the
    /// provider picker existed, in which case the legacy proxy fields below
    /// are promoted into it — see [`load`].
    #[serde(default)]
    pub ai: Option<AiConfig>,

    // ---- legacy (pre-provider-picker) fields, read for migration only ----
    /// OpenAI-compatible chat-completions URL for AI enhance.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub proxy_url: String,
    /// Bearer key sent to that endpoint.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub proxy_key: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Promote a pre-provider-picker `proxy_url`/`proxy_key` pair into the
/// OpenAI-compatible provider, so an endpoint saved before the picker landed
/// keeps working without the player re-entering it. The old proxy URL was a
/// full chat-completions URL; `AiConfig.base_url` is the base it hangs off.
fn migrate_legacy_proxy(settings: &mut Settings) {
    if settings.ai.is_some() || settings.proxy_url.trim().is_empty() {
        return;
    }
    settings.ai = Some(AiConfig {
        provider: "openai".into(),
        base_url: settings
            .proxy_url
            .trim()
            .trim_end_matches("/chat/completions")
            .to_string(),
        api_key: settings.proxy_key.trim().to_string(),
        // No model was stored back then (the proxy pinned one server-side);
        // the Setup screen's default fills in and the player can change it.
        model: String::new(),
    });
}

/// Load saved settings; any missing/broken file just yields defaults.
pub fn load(app: &AppHandle) -> Settings {
    let mut settings: Settings = settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    migrate_legacy_proxy(&mut settings);
    settings
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotes_a_legacy_proxy_into_the_compatible_provider() {
        let mut settings = Settings {
            ai: None,
            proxy_url: "https://proxy.example/v1/chat/completions".into(),
            proxy_key: "sk-old".into(),
        };
        migrate_legacy_proxy(&mut settings);
        let ai = settings.ai.expect("legacy proxy should be promoted");
        assert_eq!(ai.provider, "openai");
        assert_eq!(ai.base_url, "https://proxy.example/v1");
        assert_eq!(ai.api_key, "sk-old");
    }

    #[test]
    fn leaves_an_existing_provider_config_alone() {
        let mut settings = Settings {
            ai: Some(AiConfig {
                provider: "openrouter".into(),
                api_key: "sk-or-current".into(),
                ..AiConfig::default()
            }),
            proxy_url: "https://stale.example/v1/chat/completions".into(),
            proxy_key: "sk-stale".into(),
        };
        migrate_legacy_proxy(&mut settings);
        let ai = settings.ai.expect("config stays");
        assert_eq!(ai.provider, "openrouter");
        assert_eq!(ai.api_key, "sk-or-current");
    }

    #[test]
    fn a_blank_file_migrates_to_nothing() {
        let mut settings = Settings::default();
        migrate_legacy_proxy(&mut settings);
        assert!(settings.ai.is_none(), "no provider invented from nothing");
    }
}
