use serde::{Deserialize, Serialize};

/// One OAuth authorization round trip through the system browser.
///
/// The caller does NOT supply a redirect URI: it can't know one that works.
/// The plugin opens a loopback listener, appends its address to `auth_url`
/// under `callback_param`, and hands the finished URL to the native sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeRequest {
    /// The provider's authorize URL, already carrying everything the caller
    /// controls (PKCE challenge, scopes, …) but no redirect URI.
    pub auth_url: String,
    /// Query parameter the provider expects the redirect URI in — OpenRouter
    /// calls it `callback_url`, most others `redirect_uri`.
    pub callback_param: String,
}

/// The redirect the provider finished on, verbatim. Pulling the one-shot code
/// (and any state) out of it is the caller's job: this plugin stays agnostic
/// about which parameters a given provider returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeResponse {
    pub callback_url: String,
}
