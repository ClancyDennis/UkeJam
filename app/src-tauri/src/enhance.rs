//! AI tab enhancement — normalize a messy pasted tab into clean ChordPro via
//! an OpenAI-compatible LLM proxy. Ported from the prototype's importer.py.
//!
//! The call lives in Rust (not the webview) so the API key stays out of the
//! frontend and we avoid browser CORS to localhost:4000.

use serde_json::json;

const PROXY_URL: &str = "http://localhost:4000/v1/chat/completions";
const PROXY_KEY: &str = "sk-1234";
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

/// Send raw tab text to the proxy; return cleaned ChordPro (or an error string).
pub fn enhance_tab(raw: &str) -> Result<String, String> {
    let body = json!({
        "model": MODEL,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": format!("Convert this tab to ChordPro:\n\n{raw}") }
        ]
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .post(PROXY_URL)
        .header("Authorization", format!("Bearer {PROXY_KEY}"))
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
