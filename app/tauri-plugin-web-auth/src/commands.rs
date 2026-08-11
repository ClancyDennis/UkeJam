use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Error;
use crate::Result;
use crate::WebAuthExt;

#[command]
pub(crate) async fn authorize<R: Runtime>(
    app: AppHandle<R>,
    payload: AuthorizeRequest,
) -> Result<AuthorizeResponse> {
    // Unlike the other native bridges in this app, this one is up for as long
    // as the player takes to sign in — minutes, with a passkey prompt and an
    // SSO detour in the middle. Run it on a blocking thread so it can't sit on
    // an async runtime worker for the duration.
    tauri::async_runtime::spawn_blocking(move || app.web_auth().authorize(payload))
        .await
        .map_err(|error| Error::Plugin(format!("the sign-in task did not finish: {error}")))?
}
