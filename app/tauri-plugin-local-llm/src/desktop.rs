use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime>(
    app: &AppHandle<R>,
    _api: PluginApi<R, ()>,
) -> crate::Result<LocalLlm<R>> {
    Ok(LocalLlm(app.clone()))
}

/// Desktop bridge to Apple's on-device Foundation model.
///
/// On macOS with the helper binary compiled in (see build.rs), the chat command is
/// served by a long-lived Swift subprocess — the same `LanguageModelSession` path
/// the iOS plugin uses. Everywhere else these report `unsupportedHost` and the
/// caller falls back to a remote OpenAI-compatible endpoint.
pub struct LocalLlm<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> LocalLlm<R> {
    pub fn availability(&self) -> Result<AvailabilityResponse> {
        #[cfg(localllm_helper)]
        {
            // A helper that cannot start is indistinguishable, to the player, from a
            // device without the model — report it the same way rather than erroring.
            return Ok(AvailabilityResponse {
                status: helper::availability().unwrap_or_else(|_| "unavailable".into()),
            });
        }
        #[cfg(not(localllm_helper))]
        Ok(AvailabilityResponse {
            status: "unsupportedHost".into(),
        })
    }

    pub fn chat(&self, payload: ChatRequest) -> Result<ChatReply> {
        #[cfg(localllm_helper)]
        {
            return helper::chat(payload);
        }
        #[cfg(not(localllm_helper))]
        {
            let _ = payload;
            Err(unsupported())
        }
    }
}

#[cfg(not(localllm_helper))]
fn unsupported() -> Error {
    Error::Plugin("on-device model is only available on Apple devices".into())
}

/// Supervises the Swift helper process and the newline-JSON protocol it speaks.
///
/// Requests carry an `id` and replies are matched back to it, so several
/// generations can be in flight at once even though each one takes seconds.
#[cfg(localllm_helper)]
mod helper {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use serde_json::{json, Value};

    use crate::models::*;
    use crate::{Error, Result};

    /// Compiled in by build.rs. Kept as a path rather than embedded bytes so a dev
    /// rebuild of the Swift side is picked up without relinking the whole app.
    const HELPER_BIN: &str = env!("LOCALLLM_HELPER_BIN");

    /// Generous: an on-device generation is seconds, and a cold first call also pays
    /// the instructions prefill. Tab cleanup is a background import step, so this is
    /// only a backstop against a wedged helper leaking a blocked thread forever.
    const REPLY_TIMEOUT: Duration = Duration::from_secs(240);

    struct Helper {
        stdin: Mutex<ChildStdin>,
        pending: &'static Mutex<HashMap<u64, Sender<Value>>>,
        next_id: Mutex<u64>,
        #[allow(dead_code)]
        child: Child,
    }

    fn pending_map() -> &'static Mutex<HashMap<u64, Sender<Value>>> {
        static PENDING: OnceLock<Mutex<HashMap<u64, Sender<Value>>>> = OnceLock::new();
        PENDING.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn helper() -> Result<&'static Helper> {
        static HELPER: OnceLock<Option<Helper>> = OnceLock::new();
        HELPER
            .get_or_init(|| spawn().ok())
            .as_ref()
            .ok_or_else(|| Error::Plugin("could not start the on-device model helper".into()))
    }

    fn spawn() -> Result<Helper> {
        let mut child = Command::new(HELPER_BIN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Leave stderr inherited: Swift crashes then show up in the app log
            // instead of vanishing.
            .spawn()
            .map_err(|error| Error::Plugin(format!("spawning the on-device helper failed: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Plugin("helper stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Plugin("helper stdout unavailable".into()))?;

        let pending = pending_map();
        std::thread::Builder::new()
            .name("localllm-helper-reader".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    let Some(id) = value.get("id").and_then(Value::as_u64) else {
                        continue;
                    };
                    // Dropping the sender when nobody is waiting is fine: the
                    // requester timed out and moved on.
                    if let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&id)) {
                        let _ = sender.send(value);
                    }
                }
                // stdout closed: the helper died. Wake every waiter so they fail
                // fast instead of blocking until REPLY_TIMEOUT.
                if let Ok(mut map) = pending.lock() {
                    map.clear();
                }
            })
            .map_err(|error| Error::Plugin(format!("helper reader thread failed: {error}")))?;

        Ok(Helper {
            stdin: Mutex::new(stdin),
            pending,
            next_id: Mutex::new(1),
            child,
        })
    }

    /// Send one request and block until its reply (or the backstop timeout).
    fn request(mut body: Value) -> Result<Value> {
        let helper = helper()?;
        let id = {
            let mut next = helper
                .next_id
                .lock()
                .map_err(|_| Error::Plugin("helper id lock poisoned".into()))?;
            let id = *next;
            *next += 1;
            id
        };
        body["id"] = json!(id);

        let (sender, receiver) = channel();
        helper
            .pending
            .lock()
            .map_err(|_| Error::Plugin("helper pending lock poisoned".into()))?
            .insert(id, sender);

        // Write the whole line under one lock so concurrent requests can't interleave.
        {
            let mut stdin = helper
                .stdin
                .lock()
                .map_err(|_| Error::Plugin("helper stdin lock poisoned".into()))?;
            let line = format!("{body}\n");
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.flush())
                .map_err(|error| {
                    Error::Plugin(format!("the on-device helper is not accepting requests: {error}"))
                })?;
        }

        let value = receiver.recv_timeout(REPLY_TIMEOUT).map_err(|_| {
            // Stop tracking it so a late reply doesn't accumulate in the map.
            if let Ok(mut map) = helper.pending.lock() {
                map.remove(&id);
            }
            Error::Plugin("the on-device model did not answer in time".into())
        })?;

        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(value);
        }
        Err(Error::Plugin(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("on-device generation failed")
                .to_string(),
        ))
    }

    pub(super) fn availability() -> Result<String> {
        Ok(request(json!({ "cmd": "availability" }))?
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unavailable")
            .to_string())
    }

    pub(super) fn chat(payload: ChatRequest) -> Result<ChatReply> {
        let messages: Vec<Value> = payload
            .messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content }))
            .collect();
        let value = request(json!({
            "cmd": "chat",
            "messages": messages,
            "maxTokens": payload.max_tokens,
            "temperature": payload.temperature,
        }))?;
        Ok(ChatReply {
            content: value
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }
}
