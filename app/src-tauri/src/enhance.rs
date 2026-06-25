//! AI tab enhancement — normalize a messy pasted tab into clean ChordPro via
//! an OpenAI-compatible LLM proxy. Ported from the prototype's importer.py.
//!
//! The call lives in Rust (not the webview) so the API key stays out of the
//! frontend and we avoid browser CORS to localhost:4000.

use serde_json::json;

// Defaults target the local dev proxy; override with env vars so the URL/key
// aren't baked into the binary (and can point at a different proxy per machine).
const DEFAULT_PROXY_URL: &str = "http://localhost:4000/v1/chat/completions";
const DEFAULT_PROXY_KEY: &str = "sk-1234";
const MODEL: &str = "claude-sonnet-4-6";

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

/// Send tab text to the proxy; return cleaned ChordPro (or an error string).
/// `mode` selects the system prompt; `lyrics` is the second payload for Fuse.
pub fn enhance_tab(raw: &str, mode: Mode, lyrics: Option<&str>) -> Result<String, String> {
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
    let body = json!({
        "model": MODEL,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });

    let proxy_url =
        std::env::var("UKEJAM_PROXY_URL").unwrap_or_else(|_| DEFAULT_PROXY_URL.to_string());
    let proxy_key =
        std::env::var("UKEJAM_PROXY_KEY").unwrap_or_else(|_| DEFAULT_PROXY_KEY.to_string());

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .post(proxy_url)
        .header("Authorization", format!("Bearer {proxy_key}"))
        .json(&body)
        .send()
        .map_err(|e| format!("request failed (is the proxy at localhost:4000 running?): {e}"))?;

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
