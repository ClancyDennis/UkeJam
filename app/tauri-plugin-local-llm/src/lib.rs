//! Tauri plugin exposing Apple's on-device intelligence to the app:
//! Foundation-model availability plus one-shot chat completions.
//!
//! Ported from Wormdrop Battleground's plugin, trimmed to the chat surface —
//! ukejam's tab cleanup is a single stateless completion per import, so the
//! prewarmed-session and speech commands were left behind.
//!
//! The Swift implementation lives in `ios/Sources/`. On macOS the same calls
//! are served by a helper binary compiled from `macos/` (see build.rs). On any
//! other host the desktop stub reports `unsupportedHost` so callers
//! transparently fall back to a remote OpenAI-compatible endpoint.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result};
pub use models::*;

mod commands;
mod error;
mod models;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::LocalLlm;
#[cfg(mobile)]
use mobile::LocalLlm;

/// Convenience accessor: `app.local_llm()` reaches the managed plugin state.
pub trait LocalLlmExt<R: Runtime> {
    fn local_llm(&self) -> &LocalLlm<R>;
}

impl<R: Runtime, T: Manager<R>> LocalLlmExt<R> for T {
    fn local_llm(&self) -> &LocalLlm<R> {
        self.state::<LocalLlm<R>>().inner()
    }
}

/// Register the plugin: `tauri::Builder::default().plugin(tauri_plugin_local_llm::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("local-llm")
        .invoke_handler(tauri::generate_handler![
            commands::availability,
            commands::chat
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let local_llm = mobile::init(app, api)?;
            #[cfg(desktop)]
            let local_llm = desktop::init(app, api)?;
            app.manage(local_llm);
            Ok(())
        })
        .build()
}
