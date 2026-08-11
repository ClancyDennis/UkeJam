use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::error::UNSUPPORTED_HOST;
use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime>(app: &AppHandle<R>, _api: PluginApi<R, ()>) -> crate::Result<WebAuth<R>> {
    Ok(WebAuth(app.clone()))
}

/// Desktop has no native sheet wired up (`ASWebAuthenticationSession` exists on
/// macOS, but this plugin only ships the iOS side today). Reporting
/// `unsupportedHost` is the contract that tells the web layer to run its own
/// in-page OAuth redirect instead — the flow desktop and browser builds have
/// always used.
pub struct WebAuth<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> WebAuth<R> {
    pub fn authorize(&self, _payload: AuthorizeRequest) -> Result<AuthorizeResponse> {
        Err(Error::Plugin(UNSUPPORTED_HOST.into()))
    }
}
