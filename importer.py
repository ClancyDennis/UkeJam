"""Import tabs in various formats -> canonical ChordPro.

Many online tabs put chords on the line ABOVE the lyric, aligned by column:

    Am          G            C
    I was scared of dentists and the dark

This module converts that to inline ChordPro:  [Am]I was scared of [G]dentists...

Two paths:
  - convert_chords_above_lyrics(): deterministic, fast, for clean column-aligned
    input (no API needed).
  - llm_normalize_prompt(): the prompt for an LLM to robustly normalize MESSY
    real-world tabs (section headers, capo notes, ragged alignment, embedded
    tablature). The Tauri app calls Claude with this; here we just expose the
    prompt + a pluggable caller so it's testable.
"""

import re
from song import CHORD_TOKEN_RE

# A line is a "chord line" if every whitespace-separated token looks like a chord.
def is_chord_line(line):
    toks = line.split()
    if not toks:
        return False
    return all(CHORD_TOKEN_RE.match(t) for t in toks)


def _chord_positions(chord_line):
    """Return [(column_index, chord), ...] for a chord line."""
    return [(m.start(), m.group())
            for m in re.finditer(r"\S+", chord_line)]


def convert_chords_above_lyrics(text):
    """Convert column-aligned chords-above-lyrics into inline ChordPro.

    Pairs each chord line with the lyric line immediately below it and inserts
    [chord] markers at the matching column. Lines that are already directives,
    blank, or standalone chord lines (no lyric below) are passed through.
    """
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        if is_chord_line(line) and nxt is not None and not is_chord_line(nxt) \
                and nxt.strip():
            out.append(_merge(line, nxt))
            i += 2
        elif is_chord_line(line):
            # chord line with no lyric below: emit chords inline, no lyric
            chords = "".join(f"[{c}]" for _, c in _chord_positions(line))
            out.append(chords)
            i += 1
        else:
            out.append(line)
            i += 1
    return "\n".join(out)


def _merge(chord_line, lyric_line):
    """Insert [chord] markers into lyric_line at the chords' columns."""
    positions = _chord_positions(chord_line)
    result = []
    last = 0
    for col, chord in positions:
        col = min(col, len(lyric_line))   # clamp if lyric is shorter
        result.append(lyric_line[last:col])
        result.append(f"[{chord}]")
        last = col
    result.append(lyric_line[last:])
    return "".join(result)


# --- LLM path (robust normalizer for messy tabs) --------------------------

LLM_SYSTEM = (
    "You convert guitar/ukulele tabs and chord charts into ChordPro format "
    "for a chord-detection play-along app. The app LISTENS for chords, so we "
    "only want the chord progression with lyrics, not single-note tablature.\n"
    "ChordPro puts chords inline in square brackets immediately before the "
    "syllable they fall on, e.g. '[Am]I was [G]scared'.\n"
    "Rules:\n"
    "(1) Output ONLY ChordPro, no commentary, no code fences.\n"
    "(2) Put {title:} and {artist:} at the top if known, {key:} if stated.\n"
    "(3) Preserve lyrics exactly; only relocate chord names inline above their "
    "syllable.\n"
    "(4) DROP ASCII tablature staves (lines like 'e|---4--4--|') and "
    "fret-number riffs entirely — they are single notes, not chords. But if a "
    "tab staff has chord NAMES written above it (e.g. 'G   A'), keep those "
    "chords.\n"
    "(5) Mark sections with {comment: Verse}, {comment: Chorus}, etc.\n"
    "(6) If chords sit on the line above the lyrics, align each chord to the "
    "syllable beneath its starting column.\n"
    "(7) For chord-only lines (intros, outros) with no lyrics, emit the chords "
    "inline on their own line, e.g. '[B] [F#m] [E]'.\n"
    "(8) Keep chord names as written (B5, Badd4/E, F#m, Dmaj7 are all fine)."
)


def llm_normalize_prompt(raw_tab):
    """Return (system, user) messages for an LLM to normalize a messy tab."""
    return LLM_SYSTEM, f"Convert this tab to ChordPro:\n\n{raw_tab}"


# OpenAI-compatible proxy caller (stdlib only, no SDK dependency).
PROXY_URL = "http://localhost:4000/v1/chat/completions"
PROXY_KEY = "sk-1234"
PROXY_MODEL = "claude-sonnet-4-6"


def proxy_llm_caller(system, user, model=PROXY_MODEL, url=PROXY_URL, key=PROXY_KEY):
    """Call an OpenAI-compatible chat endpoint. Returns the response text."""
    import json
    import urllib.request

    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    text = data["choices"][0]["message"]["content"].strip()
    # strip accidental code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return text


def normalize(text, llm_caller=None):
    """Best-effort normalize to ChordPro.

    If `llm_caller` is provided (a fn taking (system, user) -> str) and the
    input looks messy, use it; otherwise fall back to the deterministic
    column converter. Inline ChordPro is returned unchanged.
    """
    if "[" in text and "]" in text and not _looks_column_aligned(text):
        return text  # already ChordPro-ish
    if llm_caller is not None:
        system, user = llm_normalize_prompt(text)
        return llm_caller(system, user)
    return convert_chords_above_lyrics(text)


def _looks_column_aligned(text):
    lines = text.splitlines()
    return any(is_chord_line(l) for l in lines)


if __name__ == "__main__":
    raw = """Am          G            C
I was scared of dentists and the dark
Am          G            C
I was scared of pretty girls and starting conversations"""
    print("=== input (chords above lyrics) ===")
    print(raw)
    print("\n=== converted to ChordPro ===")
    converted = convert_chords_above_lyrics(raw)
    print(converted)
    print("\n=== parsed back ===")
    from song import parse_chordpro
    song = parse_chordpro(converted)
    for line in song.lines:
        print("  chords:", line.chords, "| lyric:", repr(line.lyrics))
