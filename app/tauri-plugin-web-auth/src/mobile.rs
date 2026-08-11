use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::loopback::LoopbackServer;
use crate::models::*;
use crate::url::append_query_param;
use crate::{Error, Result};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_web_auth);

/// The scheme the loopback callback bounces to so the native session knows the
/// flow is over. It never leaves the device and is never registered in
/// `Info.plist`: `ASWebAuthenticationSession` intercepts its own callback
/// scheme itself, which is exactly why no associated-domain entitlement (and
/// no hosted redirect page) is needed here.
const CALLBACK_SCHEME: &str = "ukejam-auth";

pub fn init<R: Runtime>(_app: &AppHandle<R>, api: PluginApi<R, ()>) -> crate::Result<WebAuth<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_web_auth)?;
    Ok(WebAuth(handle))
}

/// Mirrors the Swift `AuthorizeArgs`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAuthorizeRequest {
    url: String,
    scheme: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAuthorizeResponse {
    callback_url: String,
}

/// Access to the native (Swift) `ASWebAuthenticationSession` plugin.
pub struct WebAuth<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> WebAuth<R> {
    /// Blocks until the player finishes (or dismisses) the sign-in sheet, so
    /// callers must keep this off an async runtime worker — `commands.rs`
    /// hands it to a blocking thread.
    pub fn authorize(&self, payload: AuthorizeRequest) -> Result<AuthorizeResponse> {
        let server = LoopbackServer::start(CALLBACK_SCHEME).map_err(|error| {
            Error::Plugin(format!("could not open the local sign-in listener: {error}"))
        })?;
        let url = append_query_param(
            &payload.auth_url,
            &payload.callback_param,
            &server.redirect_uri(),
        );
        let native: Result<NativeAuthorizeResponse> = self
            .0
            .run_mobile_plugin(
                "authorize",
                NativeAuthorizeRequest {
                    url,
                    scheme: CALLBACK_SCHEME.into(),
                },
            )
            .map_err(Into::into);

        match native {
            Ok(response) => Ok(AuthorizeResponse {
                callback_url: response.callback_url,
            }),
            // The custom-scheme bounce is only how the sheet *dismisses*. The
            // code itself arrived over loopback a moment earlier, so a session
            // that ended without reporting a callback — a dismissal read as a
            // cancel, a bounce the sheet declined to follow — has still
            // completed the sign-in. Prefer the captured callback over the
            // error rather than making the player start over.
            Err(error) => match server.captured() {
                Some(callback_url) => Ok(AuthorizeResponse { callback_url }),
                None => Err(error),
            },
        }
    }
}
