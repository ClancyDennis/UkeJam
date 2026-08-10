//! LLM calls — tab enhancement (messy paste -> clean ChordPro, ported from the
//! prototype's importer.py) and live practice coaching (graded bars -> advice).
//!
//! The call lives in Rust (not the webview) so the API key stays out of the
//! frontend and we avoid browser CORS to localhost:4000.

use serde_json::json;
use std::time::Duration;

// Defaults target the local dev proxy; override with env vars so the URL/key
// aren't baked into the binary (and can point at a different proxy per machine).
const DEFAULT_PROXY_URL: &str = "http://localhost:4000/v1/chat/completions";
const DEFAULT_PROXY_KEY: &str = "sk-1234";
const MODEL: &str = "claude-sonnet-4-6";
/// Coaching model when nothing is configured. Same default as tab enhancement,
/// but resolved separately so the two can diverge without a rebuild.
const DEFAULT_COACH_MODEL: &str = "claude-sonnet-4-6";

/// Tab enhancement converts a whole song and the user is waiting on a screen,
/// so it can afford minutes.
const ENHANCE_TIMEOUT: Duration = Duration::from_secs(120);
/// Coaching fires mid-practice. Advice that arrives two minutes later is about a
/// part of the song the player has long since left, so give up early instead.
const COACH_TIMEOUT: Duration = Duration::from_secs(20);

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

/// Where a request should go and as whom.
pub struct Endpoint {
    pub url: String,
    pub key: String,
    /// Model for the coaching path. Tab enhancement uses the compiled-in MODEL.
    pub coach_model: String,
}

/// env var > saved setting (Setup screen) > compiled-in default. Saved settings
/// matter most on iOS, where a localhost proxy can't exist and env vars can't be
/// set.
fn pick(env: &str, saved: &str, default: &str) -> String {
    std::env::var(env)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if saved.trim().is_empty() {
                default.to_string()
            } else {
                saved.trim().to_string()
            }
        })
}

/// Resolve the proxy endpoint from env vars and saved settings.
pub fn resolve_proxy(saved: &crate::settings::Settings) -> Endpoint {
    Endpoint {
        url: pick("UKEJAM_PROXY_URL", &saved.proxy_url, DEFAULT_PROXY_URL),
        key: pick("UKEJAM_PROXY_KEY", &saved.proxy_key, DEFAULT_PROXY_KEY),
        coach_model: pick(
            "UKEJAM_COACH_MODEL",
            &saved.coach_model,
            DEFAULT_COACH_MODEL,
        ),
    }
}

/// Send tab text to the proxy; return cleaned ChordPro (or an error string).
/// `mode` selects the system prompt; `lyrics` is the second payload for Fuse.
pub fn enhance_tab(
    raw: &str,
    mode: Mode,
    lyrics: Option<&str>,
    proxy_url: &str,
    proxy_key: &str,
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
    chat(system, &user, MODEL, ENHANCE_TIMEOUT, proxy_url, proxy_key)
}

/// Turn a digest of graded bars (see `VerdictBuffer::digest`) into short practice
/// advice. Separate entry point from `enhance_tab` because coaching runs on its
/// own configurable model and a much shorter timeout.
pub fn coach_bars(
    digest: &str,
    endpoint: &Endpoint,
    reason: &str,
) -> Result<String, String> {
    // The reason is context, not an instruction — it tells the model whether the
    // player just stopped, finished, or is mid-struggle, which changes what is
    // worth saying.
    let user = format!("Trigger: {reason}\n\nBars just played:\n\n{digest}");
    chat(
        SYSTEM_COACH,
        &user,
        &endpoint.coach_model,
        COACH_TIMEOUT,
        &endpoint.url,
        &endpoint.key,
    )
}

/// One chat-completions round trip. Returns the assistant's text with any stray
/// ``` fences stripped.
fn chat(
    system: &str,
    user: &str,
    model: &str,
    timeout: Duration,
    proxy_url: &str,
    proxy_key: &str,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .post(proxy_url)
        .header("Authorization", format!("Bearer {proxy_key}"))
        .json(&body)
        .send()
        .map_err(|e| format!("request to {proxy_url} failed (endpoint reachable? configurable in Setup): {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("proxy returned {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().map_err(|e| format!("bad response: {e}"))?;
    let mut text = data["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("no content in response")?
        .trim()
        .to_string();

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
