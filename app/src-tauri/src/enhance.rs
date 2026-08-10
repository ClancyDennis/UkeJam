//! AI tab enhancement — normalize a messy pasted tab into clean ChordPro via
//! a chat model. Ported from the prototype's importer.py.
//!
//! The player picks the provider in Setup: Apple Intelligence (on-device, via
//! the local-llm plugin), OpenRouter, or any OpenAI-compatible endpoint. The
//! remote calls live in Rust (not the webview) to avoid browser CORS against
//! arbitrary endpoints; the config travels with each invoke so the frontend
//! owns persistence.

use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_local_llm::{ChatMessage, ChatRequest, LocalLlmExt};

const SYSTEM: &str = "\
You convert guitar/ukulele tabs and chord charts into ChordPro format for a \
chord-detection play-along app. The app LISTENS for chords, so we only want the \
chord progression with lyrics, not single-note tablature.\n\
ChordPro puts chords inline in square brackets immediately before the syllable \
they fall on, e.g. '[Am]I was [G]scared'.\n\
Rules:\n\
(1) Output ONLY ChordPro, no commentary, no code fences.\n\
(2) Put {title:} and {artist:} at the top if known, {key:} if stated.\n\
(3) Preserve lyrics exactly; only relocate chord names inline above their syllable.\n\
(4) DROP ASCII tablature staves (lines like 'e|---4--4--|') and fret-number riffs \
entirely — they are single notes, not chords. But if a tab staff has chord NAMES \
written above it (e.g. 'G   A'), keep those chords.\n\
(5) Mark sections with {comment: Verse}, {comment: Chorus}, etc.\n\
(6) If chords sit on the line above the lyrics, align each chord to the syllable \
beneath its starting column.\n\
(7) For chord-only lines (intros, outros) with no lyrics, emit the chords inline \
on their own line, e.g. '[B] [F#m] [E]'.\n\
(8) Keep chord names as written (B5, Badd4/E, F#m, Dmaj7 are all fine).\n\
(9) Add bar/measure breaks using the pipe character '|' to group chords into \
measures based on the song's structure and standard chord-chart conventions, \
e.g. '| [G] | [C] [D] | [Em] |'. Put a '|' at the start and between every \
measure. Do NOT invent tempo or durations — just the measure groupings. For \
lines with lyrics, you may still place '|' bar markers inline among the \
[chords] where measures fall.";

// A MIDI import is ALREADY clean ChordPro (| bar | chords + {tempo:}), derived
// note-by-note from selected channels. The AI's job here is different: simplify
// the over-specific chord names that note-exact extraction produces into what a
// player would actually strum, WITHOUT touching the timing.
const SYSTEM_MIDI: &str = "\
You are cleaning up a chord chart that was auto-extracted from a MIDI file for a \
ukulele play-along app. The input is already valid ChordPro: a {title:}/{artist:}/\
{tempo:}/{time:} header, then lines of '| [Chord] | [Chord] |' measures.\n\
Your job is to make the PROGRESSION playable and musical, not to restructure it.\n\
Rules:\n\
(1) Output ONLY ChordPro, no commentary, no code fences.\n\
(2) Keep the header directives ({title:}, {artist:}, {tempo:}, {time:}) EXACTLY.\n\
(3) Keep the SAME number of measures and the SAME '|' bar structure — one chord \
per measure, same order. Do NOT merge, split, add, or remove measures (timing \
must stay aligned to the song).\n\
(4) Simplify over-specific chord names from note-exact extraction to the chord a \
player would actually strum: prefer plain major/minor triads; collapse spurious \
'5'/'sus2'/'sus4'/'add9'/'maj7'/'m7b5'/'dim' that are really just a triad with a \
passing tone. Keep a 7th or sus only when it's clearly intentional and sustained \
across the measure. Example: a bar reading 'Em7b5' surrounded by 'Em' should \
become 'Em'.\n\
(5) Smooth obvious one-bar anomalies to fit the surrounding progression (a single \
odd chord between two identical chords is usually that same chord).\n\
(6) Keep chord roots as written unless clearly an extraction artifact. Do not \
transpose.";

// Fuse a timed MIDI chord chart with a lyric sheet. The app keeps the bar/chord
// STRUCTURE under its own control and asks the LLM ONLY for the words sung in
// each numbered bar — so it can never change the bar count or chords (which
// would desync the lyrics from the recording). Output is plain `N: words` lines.
const SYSTEM_FUSE: &str = "\
You align song lyrics to a numbered list of musical bars for a play-along app.\n\
INPUT A is a numbered list of bars, each with its chord, like:\n\
  1. Am\n  2. Am\n  3. F\n  ...\n\
INPUT B is the song's lyrics (a chord/lyric tab or plain words).\n\
Decide which words are sung during each bar and output ONE line per bar that has \
lyrics, in the form:\n\
  <barNumber>: <the words sung in that bar>\n\
Rules:\n\
(1) Output ONLY these 'number: words' lines, nothing else — no chords, no commentary, \
no code fences, no blank-line padding.\n\
(2) Use ONLY bar numbers that appear in A (1..N). Skip bars with no lyrics (intros, \
solos, instrumental breaks) — just omit those numbers.\n\
(3) Put a natural few words per bar (what is actually sung as that chord rings). Do \
not cram a whole verse into one bar.\n\
(4) Follow A's structure: where the chord progression repeats (e.g. a recurring \
chorus), repeat the matching lyrics on those bar numbers.\n\
(5) Keep the words verbatim from B; do not invent or translate lyrics.\n\
(6) It's fine to leave many bars blank if B is short — only map what the lyrics cover.";

/// What kind of enhancement to run.
pub enum Mode {
    /// Convert a messy pasted tab into clean ChordPro.
    Messy,
    /// Simplify an already-clean MIDI-extracted chart's chord names.
    Midi,
    /// Fuse a timed MIDI chart (`raw`) with a lyric tab (`lyrics`).
    Fuse,
}

/// The provider settings the frontend keeps (Setup view, localStorage) and
/// sends along with every AI invoke.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// `apple` (on-device), `openrouter`, or `openai` (any compatible endpoint).
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

impl AiConfig {
    fn is_apple(&self) -> bool {
        self.provider == "apple"
    }

    fn chat_url(&self) -> Result<String, String> {
        let base = self.base_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("no endpoint configured — set up AI enhance in ⚙ Setup".into());
        }
        Ok(format!("{base}/chat/completions"))
    }
}

/// Whether to send `temperature: 0` to this model. Reasoning models (o-series,
/// GPT-5 family) and the temperature-rejecting Claude generations (all Opus,
/// the "5" line) 400 on a custom temperature; omitting it just uses the model
/// default. Ported from Wormdrop's modelSupportsTemperature.
fn model_accepts_temperature(model: &str) -> bool {
    // OpenRouter ids carry "vendor/" (and "~" auto-router) prefixes — judge the
    // bare id so "openai/gpt-5" behaves like "gpt-5".
    let bare = model.trim_start_matches('~');
    let name = bare.rsplit('/').next().unwrap_or(bare).to_ascii_lowercase();
    let reasoning = (name.starts_with('o')
        && name.chars().nth(1).is_some_and(|c| c.is_ascii_digit()))
        || (name.starts_with("gpt-5") && !name.contains("chat"));
    let claude_no_temp = name.contains("claude")
        && (name.contains("opus")
            || ["sonnet-5", "haiku-5", "fable-5", "mythos-5"]
                .iter()
                .any(|family| name.contains(&format!("claude-{family}"))));
    !reasoning && !claude_no_temp
}

/// One completion through whichever provider the config names.
/// Blocking — callers run it on `spawn_blocking`.
fn chat(app: &AppHandle, config: &AiConfig, system: &str, user: &str) -> Result<String, String> {
    if config.is_apple() {
        return apple_chat(app, config, system, user);
    }
    remote_chat(config, system, user)
}

/// On-device completion via the local-llm plugin (macOS helper / iOS Swift).
fn apple_chat(
    app: &AppHandle,
    _config: &AiConfig,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(ChatMessage {
            role: "system".into(),
            content: system.into(),
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: user.into(),
    });
    let reply = app
        .local_llm()
        .chat(ChatRequest {
            messages,
            max_tokens: None,
            temperature: Some(0.0),
        })
        .map_err(|e| format!("on-device model: {e}"))?;
    Ok(reply.content)
}

/// Remote completion against an OpenAI-compatible `/chat/completions`.
fn remote_chat(config: &AiConfig, system: &str, user: &str) -> Result<String, String> {
    let model = config.model.trim();
    if model.is_empty() {
        return Err("no model selected — set up AI enhance in ⚙ Setup".into());
    }
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    if model_accepts_temperature(model) {
        body["temperature"] = json!(0);
    }

    let resp = http_client()?
        .post(config.chat_url()?)
        .headers(auth_headers(config))
        .json(&body)
        .send()
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let data: serde_json::Value = resp
        .json()
        .map_err(|e| format!("bad response ({status}): {e}"))?;
    if !status.is_success() {
        // Surface the endpoint's own message when it sends one — a bare 401/404
        // hides whether the key or the model id was wrong.
        let detail = data["error"]["message"]
            .as_str()
            .or_else(|| data["message"].as_str())
            .unwrap_or("");
        return Err(if detail.is_empty() {
            format!("endpoint returned {status}")
        } else {
            format!("endpoint returned {status}: {detail}")
        });
    }

    Ok(data["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("no content in response")?
        .to_string())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn auth_headers(config: &AiConfig) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    // Keyless local endpoints (LM Studio, Ollama's compatible API) are fine —
    // only send Authorization when there is something to send.
    let key = config.api_key.trim();
    if !key.is_empty() {
        if let Ok(value) = format!("Bearer {key}").parse() {
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }
    headers
}

/// Send tab text through the configured provider; return cleaned ChordPro (or
/// an error string). `mode` selects the system prompt; `lyrics` is the second
/// payload for Fuse.
pub fn enhance_tab(
    app: &AppHandle,
    raw: &str,
    mode: Mode,
    lyrics: Option<&str>,
    config: &AiConfig,
) -> Result<String, String> {
    let (system, user) = match mode {
        Mode::Midi => (
            SYSTEM_MIDI,
            format!("Clean up this MIDI-extracted chord chart:\n\n{raw}"),
        ),
        Mode::Fuse => (
            SYSTEM_FUSE,
            format!(
                "INPUT A (numbered bars):\n\n{raw}\n\nINPUT B (lyrics):\n\n{}",
                lyrics.unwrap_or("")
            ),
        ),
        Mode::Messy => (SYSTEM, format!("Convert this tab to ChordPro:\n\n{raw}")),
    };

    let mut text = chat(app, config, system, &user)?.trim().to_string();

    // strip accidental ``` fences
    if text.starts_with("```") {
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
        if let Some(end) = text.rfind("```") {
            text = text[..end].to_string();
        }
        text = text.trim().to_string();
    }
    Ok(text)
}

/// List the model ids a remote endpoint offers (GET `{base}/models`), for the
/// Setup view's model picker. Works unauthenticated where the endpoint allows
/// it (OpenRouter's catalog does).
pub fn list_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let base = config.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("enter a base URL first".into());
    }
    let resp = http_client()?
        .get(format!("{base}/models"))
        .headers(auth_headers(config))
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("model scan failed ({})", resp.status()));
    }
    let data: serde_json::Value = resp.json().map_err(|e| format!("bad response: {e}"))?;
    let rows = data["data"].as_array().or_else(|| data.as_array());
    let mut ids: Vec<String> = rows
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    row.as_str()
                        .or_else(|| row["id"].as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// A live-fire round trip that proves the whole configuration works — key,
/// model id, endpoint, or the on-device model. Returns the model's reply.
pub fn test_connection(app: &AppHandle, config: &AiConfig) -> Result<String, String> {
    let reply = chat(app, config, "", "Reply with exactly: ready")?;
    let reply = reply.trim();
    if reply.is_empty() {
        return Err("the model replied with empty text".into());
    }
    Ok(reply.chars().take(80).collect())
}
