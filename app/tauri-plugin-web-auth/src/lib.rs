//! Tauri plugin that runs an OAuth authorization in the *platform's* browser
//! instead of the app's own webview.
//!
//! The webview the app runs in is not a browser: it has no address bar, no
//! back button and no Cancel, it shares nothing with Safari, and it cannot
//! offer iCloud Keychain passwords or passkeys. Navigating it to a sign-in
//! page therefore strands the player on a chrome-less page they can't leave,
//! having to type a password by hand — and identity providers reject embedded
//! webviews for exactly these reasons.
//!
//! On iOS the Swift side (`ios/Sources/WebAuthPlugin.swift`) presents an
//! `ASWebAuthenticationSession`: a Safari-backed sheet with a Cancel button
//! that shares Safari's cookie jar, so an existing session signs the player
//! in with one tap, and Keychain autofill, passkeys and federated sign-in all
//! work. The app keeps running underneath; nothing is unloaded.
//!
//! Everywhere else `authorize` reports `unsupportedHost` and the web layer
//! falls back to its own in-page redirect flow.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use error::{Error, Result, CANCELLED, UNSUPPORTED_HOST};
pub use models::*;

mod commands;
mod error;
mod models;
// Only the mobile path serves loopback redirects or rewrites authorize URLs,
// but both stay compiled everywhere so their unit tests run on the host.
#[cfg_attr(not(mobile), allow(dead_code))]
mod loopback;
#[cfg_attr(not(mobile), allow(dead_code))]
mod url;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::WebAuth;
#[cfg(mobile)]
use mobile::WebAuth;

/// Convenience accessor: `app.web_auth()` reaches the managed plugin state.
pub trait WebAuthExt<R: Runtime> {
    fn web_auth(&self) -> &WebAuth<R>;
}

impl<R: Runtime, T: Manager<R>> WebAuthExt<R> for T {
    fn web_auth(&self) -> &WebAuth<R> {
        self.state::<WebAuth<R>>().inner()
    }
}

/// Register the plugin: `tauri::Builder::default().plugin(tauri_plugin_web_auth::init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("web-auth")
        .invoke_handler(tauri::generate_handler![commands::authorize])
        .setup(|app, api| {
            #[cfg(mobile)]
            let web_auth = mobile::init(app, api)?;
            #[cfg(desktop)]
            let web_auth = desktop::init(app, api)?;
            app.manage(web_auth);
            Ok(())
        })
        .build()
}
