# ukejam

A play-along practice tool for **baritone ukulele** (and guitar). You load a
song, it shows you the chord to play, and it **listens to your playing** to tell
you whether your fingers are right — flagging which notes are missing or wrong.

This repo is the **Python research prototype**. It proves the whole product is
feasible — detection, coaching, song import, and the play-along scoring loop —
before building the real [Tauri](https://tauri.app) app. The detection core is
deliberately plain array math so it ports cleanly to Rust later.

## Status

| Piece | State |
|-------|-------|
| Chord detection (FFT → chroma → template match) | ✅ proven, 7/7 on synthetic chords |
| Finger-error feedback (missing / extra notes) | ✅ working |
| Robustness over a backing track | ✅ characterized — **headphone mode** is the default |
| Tab import (any format → ChordPro, via LLM) | ✅ proven on real Foo Fighters tabs |
| Song database (SQLite) | ✅ |
| Play-along scorer (timeline + tolerant scoring) | ✅ working |
| Tuning on a **real** ukulele | ⏳ the one thing left that needs the instrument |
| Rust port + Tauri UI | ⏳ not started |

Everything except real-uke tuning was built and tested without the instrument,
using synthesized audio.

## How it works

```
            ┌─────────── IMPORT ───────────┐     ┌──────── PLAY-ALONG ────────┐
 paste tab → LLM normalize → ChordPro → SQLite → chord sequence → timeline
 (any           (importer)    (song.py)  (db.py)                  (scorer.py)
  format)                                                              │
                                                          you play ────┤
                                                                       ▼
                          mic → FFT → chroma → template match → detected chord
                          (live.py)        (chords.py)                 │
                                                                       ▼
                                          compare vs. expected → HIT / WRONG
                                          (feedback.py)        + missing/extra notes
```

**Detection** turns audio into a 12-bin *chromagram* (energy per pitch class,
C…B) via one FFT, then cosine-matches it against chord templates. No ML, no
training data — robust and fast, and the core is ~30 lines of numpy.

**Coaching** diffs the chroma against the target chord's expected pitch classes:
notes that should sound but don't are **missing** (string muted / not fretted);
notes that sound but shouldn't are **extra** (finger on the wrong fret).

**Scoring** is tolerant on purpose: a chord counts as a HIT if all its target
notes are present and at most one extra rings, so harmonic overtones and added
color notes don't trigger false alarms — but genuinely wrong chords are caught.

## Modules

| File | Responsibility |
|------|----------------|
| `chords.py` | Chroma computation + chord templates + cosine matcher (the detection core) |
| `fretboard.py` | Baritone uke model (tuning **D3 G3 B3 E4**); fingerings → sounding notes |
| `feedback.py` | Finger-error feedback; synthesizes fingerings for testing |
| `robustness.py` | Mixes a backing track in and tests spectral subtraction |
| `song.py` | Song model + ChordPro parser (chords, lyrics, sections) |
| `db.py` | SQLite song library (add / list / get / update / delete) |
| `importer.py` | Any tab → ChordPro: deterministic column parser **+ LLM normalizer** |
| `scorer.py` | Play-along loop: builds a timeline, scores a performance |
| `live.py` | Real-time chord detection from the mic |
| `record.py` | Record short clips for offline tuning |
| `test_synthetic.py` | Proves the detector on synthesized chords |

## Setup

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Try it

```bash
# Prove the detector on synthetic chords (no mic needed)
python test_synthetic.py

# See finger-error feedback on right vs. wrong fingerings
python feedback.py

# How a backing track affects detection
python robustness.py

# The full play-along loop with injected mistakes
python scorer.py

# Live detection from your mic — play a chord
python live.py

# Record a clip for tuning (3-2-1 countdown, then strum)
python record.py G
```

### Tab import

The importer turns messy real-world tabs into clean ChordPro. Single-note
tablature staves are discarded (the app listens for **chords**, not lead riffs);
chord charts and chord names written above staves are kept.

It uses a local OpenAI-compatible LLM proxy at `http://localhost:4000` for the
robust path, with a deterministic column-parser fallback for clean charts.

```python
from importer import normalize, proxy_llm_caller
from db import connect, add_song

chordpro = normalize(open("some_tab.txt").read(), llm_caller=proxy_llm_caller)
conn = connect()
add_song(conn, chordpro)
```

## Design decisions

- **Instrument-agnostic songs.** A G is {G, B, D} on any instrument, so songs
  store chord *names* + lyrics. The instrument only changes the fingering
  diagram shown — one song works for uke or guitar.
- **ChordPro is the canonical format.** Human-editable, re-parsable, and what
  most chord sites export. The raw source is the source of truth in the DB.
- **Headphone mode first.** With a backing track over speakers, the mic hears a
  mix and raw detection degrades badly; naive spectral subtraction only partly
  helps (great when uke and backing diverge, poor when they share notes). The
  reliable default is to route backing audio to headphones so the mic hears
  only the instrument. Speaker mode with echo cancellation is a later, advanced
  mode.

## Known limitations

- **Tuned on synthetic audio.** Thresholds (`RMS_GATE`, `MIN_SCORE`, harmonic
  range, scorer tolerance) still need tuning against a real ukulele and mic.
- **Missing-root errors can be masked.** A string's harmonics can reconstruct a
  muted root, so a missing root is harder to detect than a wrong color note.
  Fix: per-string fundamental tracking (needs real audio to tune).
- **Single sustained-chord analysis.** Fast strumming / arpeggios within one
  chord window are averaged, not tracked note-by-note.

## Path to the Tauri app

The detection core (`chords.py`) is plain array math and ports directly to Rust:

- **Audio capture:** [`cpal`](https://crates.io/crates/cpal) (replaces `sounddevice`)
- **FFT:** [`rustfft`](https://crates.io/crates/rustfft) (replaces `numpy.fft`)
- **Database:** `rusqlite` / `sqlx` — the schema in `db.py` carries over directly
- **Tab import:** the Tauri frontend calls an LLM with the prompt in
  `importer.LLM_SYSTEM`; storage stays ChordPro
- **Frontend:** renders the current chord + fingering diagram, the lyric
  timeline, and live HIT/WRONG feedback from the Rust backend

The Python prototype stays as the reference implementation and test oracle.
