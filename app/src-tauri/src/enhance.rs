//! AI calls — tab enhancement (messy paste -> clean ChordPro, ported from the
//! prototype's importer.py) and live practice coaching (graded bars -> advice).
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

// Live practice coaching. Same split as SYSTEM_FUSE above: the app has already
// graded every bar (see verdict.ts) and those verdicts are authoritative, so the
// model is asked ONLY for the thing the app cannot compute — the pattern across
// bars. It must never re-judge a bar or restate the note names, because it has
// no audio and would be guessing at facts the app measured.
const SYSTEM_COACH: &str = "\
You are a ukulele practice coach. You are given a play-along app's own scoring of \
the bars a player just performed. Each line is one bar:\n\
  <barNumber>: expect <chord>, <what was heard> -> HIT | WRONG | MISS\n\
HIT = played acceptably. WRONG = a different chord or wrong notes sounded. \
MISS = nothing sounded (silence or a muted hand). 'late 120ms' / 'early 90ms' is \
when the strum landed relative to the bar's downbeat.\n\
'2 strums in 4 beats, 2 in time' means the player strummed twice in a four-beat \
bar and both landed on the rhythmic grid. Two rules about this:\n\
- The strum COUNT is not a score. The app does not know what strumming pattern the \
song wants, so two strums in four beats may be exactly right. Never tell the player \
to strum more or fewer times, and never call a low count a mistake.\n\
- 'in time' counts strums that landed on the beat or the half-beat between beats. \
Strums NOT in time mean loose timing, which is a real and useful thing to raise — \
but you cannot tell whether they were early or late, so do not say which.\n\
Rhythm is often more useful for a beginner than chord shapes, so prefer it when \
the bars show a pattern in it.\n\
These verdicts are measured facts. Treat them as correct.\n\
Rules:\n\
(1) Find PATTERNS ACROSS BARS, not single-bar events. 'Every change into F is \
late' or 'the chorus is solid, the bridge falls apart' is useful. 'Bar 12 was \
wrong' is not — the player already saw that on screen.\n\
(2) Output at most 3 lines, each one short sentence, in this order: up to two \
things to fix (most important first), then one thing that is working. Fewer lines \
is fine. No line may exceed about 20 words.\n\
(3) Do NOT restate note names, chord spellings, or bar numbers as a list, and do \
NOT re-judge any bar. The app already shows all of that.\n\
(4) Speak to the player in the second person, plainly and without praise padding. \
No emoji, no markdown, no bullet characters, no headings, no code fences.\n\
(5) Only mention timing if the lines actually carry early/late figures. If the \
input says it is untimed, say nothing about timing or rhythm at all.\n\
(6) If the bars show no clear pattern, say only what is working. Never invent a \
problem to have something to report.";

/// What kind of tab enhancement to run. Coaching is deliberately not a variant
/// here: it has its own model and timeout, so it gets its own entry point
/// (`coach_bars`) rather than a mode that would inherit enhancement's.
pub enum Mode {
    /// Convert a messy pasted tab into clean ChordPro.
    Messy,
    /// Simplify an already-clean MIDI-extracted chart's chord names.
    Midi,
    /// Fuse a timed MIDI chart (`raw`) with a lyric tab (`lyrics`).
    Fuse,
}

/// The provider settings chosen in Setup, persisted natively (settings.rs) and
/// sent along with every AI invoke.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
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

    /// The endpoint and key to actually call, with the legacy
    /// `UKEJAM_PROXY_URL`/`UKEJAM_PROXY_KEY` env vars taking precedence for
    /// the OpenAI-compatible provider. Those env vars predate the provider
    /// picker (they configured the localhost dev proxy), so honouring them
    /// keeps existing dev machines working without touching Setup. They are
    /// deliberately ignored for OpenRouter, whose endpoint is fixed and whose
    /// key comes from the sign-in.
    fn endpoint(&self) -> (String, String) {
        let env = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        if self.provider != "openai" {
            return (self.base_url.trim().to_string(), self.api_key.trim().to_string());
        }
        (
            // The env var names a full chat-completions URL (that is what the
            // old proxy config was), so strip the suffix chat_url re-appends.
            env("UKEJAM_PROXY_URL")
                .map(|url| url.trim_end_matches("/chat/completions").to_string())
                .unwrap_or_else(|| self.base_url.trim().to_string()),
            env("UKEJAM_PROXY_KEY").unwrap_or_else(|| self.api_key.trim().to_string()),
        )
    }

    fn chat_url(&self) -> Result<String, String> {
        let base = self.endpoint().0;
        let base = base.trim_end_matches('/');
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
/// Blocking — callers run it on `spawn_blocking`. Shared by tab enhancement
/// and the tab-search query interpreter below.
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

    let url = config.chat_url()?;
    let resp = http_client()?
        .post(&url)
        .headers(auth_headers(config))
        .json(&body)
        .send()
        // Naming the URL matters most for the custom-endpoint provider, where
        // an unreachable host is the likeliest failure and the player is the
        // one who typed the address.
        .map_err(|e| format!("request to {url} failed (endpoint reachable? configurable in ⚙ Setup): {e}"))?;

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
    let key = config.endpoint().1;
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

// The LLM leg of the tab search's ✨ smart mode: the user types a loose
// description (a lyric fragment, a vibe, a misremembered title) and the model
// emits concrete artist-title queries the normal search then runs.
const SYSTEM_FIND: &str = "\
You turn a loose description of a song into concrete search queries for a \
guitar/ukulele chord-sheet website. The description may be a lyric fragment, \
a vibe ('that whistling indie song from 2012'), a misremembered title, or \
already a clean artist + title.\n\
Rules:\n\
(1) Output 1 to 3 search queries, ONE PER LINE, most likely candidate first.\n\
(2) Each query is plain text in the form: Artist SongTitle — no quotes, no \
numbering, no dashes, no commentary.\n\
(3) If the description already names the song, just echo a cleaned-up \
'Artist Title' line.\n\
(4) Output ONLY the query lines.";

/// Expand a fuzzy song description into up to 3 concrete search queries via
/// the configured provider (tab search's ✨ smart mode).
pub fn interpret_search(
    app: &AppHandle,
    config: &AiConfig,
    description: &str,
) -> Result<Vec<String>, String> {
    let reply = chat(app, config, SYSTEM_FIND, description)?;
    Ok(reply
        .lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim())
        // tolerate "1. Artist Title" style numbering despite the prompt
        .map(|l| l.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')').trim())
        .filter(|l| !l.is_empty() && !l.starts_with("```"))
        .take(3)
        .map(str::to_string)
        .collect())
}

/// Turn a digest of graded bars (see `VerdictBuffer::digest`) into short practice
/// advice.
///
/// Goes through the same provider the player picked in Setup rather than a
/// separately-configured endpoint. An earlier version of this had its own model
/// setting and its own HTTP path, on the reasoning that coaching is a short
/// latency-sensitive turn while tab conversion is one long offline job. The
/// provider picker makes that redundant: Apple Intelligence is on-device and
/// already fast, and a second model field in Setup is a knob most players would
/// never touch. One provider, one place to configure it.
pub fn coach_bars(
    app: &AppHandle,
    digest: &str,
    reason: &str,
    config: &AiConfig,
) -> Result<String, String> {
    // The reason is context, not an instruction — it tells the model whether the
    // player just stopped, finished, or is mid-struggle, which changes what is
    // worth saying.
    let user = format!("Trigger: {reason}\n\nBars just played:\n\n{digest}");
    Ok(chat(app, config, SYSTEM_COACH, &user)?.trim().to_string())
}

/// List the model ids a remote endpoint offers (GET `{base}/models`), for the
/// Setup view's model picker. Works unauthenticated where the endpoint allows
/// it (OpenRouter's catalog does).
pub fn list_models(config: &AiConfig) -> Result<Vec<String>, String> {
    // endpoint() so an env-var override is scanned rather than the stale
    // saved URL — the catalog must match what a request would actually hit.
    let base = config.endpoint().0;
    let base = base.trim_end_matches('/');
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

const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/auth/keys";

/// Finish the OpenRouter PKCE login: trade the one-shot auth code (plus the
/// verifier the frontend kept) for a long-lived API key. Runs in Rust so the
/// webview never has to POST cross-origin to openrouter.ai.
pub fn openrouter_exchange(code: &str, verifier: &str) -> Result<String, String> {
    let resp = http_client()?
        .post(OPENROUTER_KEY_URL)
        .json(&json!({
            "code": code,
            "code_verifier": verifier,
            "code_challenge_method": "S256",
        }))
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("OpenRouter sign-in failed ({})", resp.status()));
    }
    let data: serde_json::Value = resp.json().map_err(|e| format!("bad response: {e}"))?;
    data["key"]
        .as_str()
        .or_else(|| data["api_key"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "OpenRouter did not return an API key".into())
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
