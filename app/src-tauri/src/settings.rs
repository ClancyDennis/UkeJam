//! App settings persisted as `settings.json` in the app data dir.
//!
//! This holds the instrument tuning and the ✨ AI enhance provider config: which
//! provider to use (Apple Intelligence on-device, OpenRouter, or an
//! OpenAI-compatible endpoint), and the key/model/URL it needs. It lives here
//! rather than in webview `localStorage` for the same reason the song library
//! does: the webview store is evictable under disk pressure on iOS, and losing a
//! saved OpenRouter key silently signs the player out.
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

/// Write settings, MERGING with what is already on disk rather than replacing it.
///
/// Callers send only the part they own — `ai.ts` sends `{ai: ...}`, the tuning
/// picker sends `{tuning: ...}` — because neither knows or should know about the
/// other's fields. A straight replace silently destroyed whatever the caller
/// omitted: saving an AI provider wiped the saved tuning, and the player's uke
/// quietly reverted to standard.
///
/// Absent fields are therefore left alone. That does mean a field cannot be
/// cleared by omitting it; send the empty value explicitly instead (which is what
/// "no provider" and "standard tuning" already look like).
#[tauri::command]
pub fn set_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    let mut current = serde_json::to_value(load(&app)).map_err(|e| format!("encode: {e}"))?;
    merge(&mut current, &settings);
    let json = serde_json::to_string_pretty(&current).map_err(|e| format!("encode: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write settings: {e}"))?;
    Ok(())
}

/// Recursively overlay `patch` onto `base`. Objects merge key by key; anything
/// else replaces outright, so sending a whole `ai` object still swaps it wholesale
/// rather than leaving stale sub-fields behind.
fn merge(base: &mut serde_json::Value, patch: &serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(b), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                merge(b.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (b, p) => *b = p.clone(),
    }
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
            ..Default::default()
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
            ..Default::default()
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

    /// The bug this merge exists to prevent: `ai.ts` saves `{ai: ...}` and the
    /// tuning picker saves `{tuning: ...}`, neither knowing about the other. A
    /// replacing write meant configuring an AI provider silently reset the
    /// player's ukulele to standard.
    #[test]
    fn saving_one_field_does_not_erase_the_others() {
        let mut current = serde_json::json!({
            "ai": {"provider": "openrouter", "apiKey": "sk-or-live"},
            "tuning": "baritone",
        });
        merge(&mut current, &serde_json::json!({"tuning": "standard"}));
        assert_eq!(current["tuning"], "standard");
        assert_eq!(current["ai"]["provider"], "openrouter", "ai survived");

        merge(
            &mut current,
            &serde_json::json!({"ai": {"provider": "apple", "apiKey": ""}}),
        );
        assert_eq!(current["ai"]["provider"], "apple");
        assert_eq!(current["tuning"], "standard", "tuning survived");
    }

    /// Nested objects merge key by key, so a partial `ai` patch can't blank the
    /// rest of the provider config.
    #[test]
    fn nested_objects_merge_rather_than_replace() {
        let mut current = serde_json::json!({"ai": {"provider": "openai", "model": "gpt-x"}});
        merge(&mut current, &serde_json::json!({"ai": {"model": "gpt-y"}}));
        assert_eq!(current["ai"]["provider"], "openai");
        assert_eq!(current["ai"]["model"], "gpt-y");
    }
}
