use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;
use crate::Result;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_local_llm);

pub fn init<R: Runtime>(
    _app: &AppHandle<R>,
    api: PluginApi<R, ()>,
) -> crate::Result<LocalLlm<R>> {
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_local_llm)?;
    Ok(LocalLlm(handle))
}

/// Access to the native (Swift) Foundation Models plugin running on the device.
pub struct LocalLlm<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> LocalLlm<R> {
    pub fn availability(&self) -> Result<AvailabilityResponse> {
        self.0
            .run_mobile_plugin("availability", ())
            .map_err(Into::into)
    }

    pub fn chat(&self, payload: ChatRequest) -> Result<ChatReply> {
        self.0.run_mobile_plugin("chat", payload).map_err(Into::into)
    }
}
