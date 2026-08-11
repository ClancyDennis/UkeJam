use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// The web layer only ever sees the `Display` text (see the `Serialize` impl),
/// so the two states it must branch on travel as exact sentinel strings:
/// [`UNSUPPORTED_HOST`] (fall back to the in-page login) and [`CANCELLED`]
/// (the player closed the sheet — not a failure worth an error message).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// Anything the native side rejected with, or an unsupported host.
    #[error("{0}")]
    Plugin(String),
}

/// No native browser sheet on this platform — the caller should use its own
/// (web) sign-in path rather than showing an error.
pub const UNSUPPORTED_HOST: &str = "unsupportedHost";

/// The player dismissed the sheet. Raised by the Swift side verbatim.
pub const CANCELLED: &str = "cancelled";

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
