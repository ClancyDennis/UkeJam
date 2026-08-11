use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::LocalLlmExt;
use crate::Result;

#[command]
pub(crate) async fn availability<R: Runtime>(app: AppHandle<R>) -> Result<AvailabilityResponse> {
    app.local_llm().availability()
}

#[command]
pub(crate) async fn chat<R: Runtime>(
    app: AppHandle<R>,
    payload: ChatRequest,
) -> Result<ChatReply> {
    app.local_llm().chat(payload)
}
