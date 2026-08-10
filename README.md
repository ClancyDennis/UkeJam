# ukejam

ukejam is a play-along practice app for **ukulele** — standard G-C-E-A or
baritone D-G-B-E, picked on the Setup screen. Load a song, see the chord
timeline, play along, and let the app listen for what is actually ringing. The
feedback is practical: which target notes are present, which are missing, and
which extra notes are getting into the chord.

The repo now has two active layers:

- `app/` is the Tauri app: tuner, live chord detection, song library, timed
  chord highway, MIDI import, backing-track playback, and LLM tab cleanup.
- The root Python files are the research/reference prototype for detection,
  coaching, ChordPro parsing, persistence, and scorer behavior.

There is also an untracked `experiments/` area for the next ingestion path:
audio file → Demucs stems → basic-pitch MIDI/chords.

## Current Status

| Area | State |
|------|-------|
| Tauri shell + Vite UI | Working |
| Live tuner | Working via `cpal` + FFT, standard or baritone tuning |
| Live chord detection | Working native Rust port: FFT → chroma → template match |
| Missing / extra note feedback | Working for target chords |
| Onset (strum) detection | Working: spectral flux vs. a self-scaling baseline |
| Per-bar scoring | Working: HIT / WRONG / MISS per bar, with strum timing |
| Live practice coaching | Working: graded bars → LLM advice across bars (needs an endpoint) |
| Chord diagrams | Working: verified shape tables per tuning, generator fallback |
| Song library | Working as JSON in the app data dir; Python prototype uses SQLite |
| Pasted tab / ChordPro import | Working, with local LLM proxy enhancement |
| MIDI import | Working: parses SMF, derives timed chord chart, selects chord-source channels |
| MIDI backing playback | Working via `rustysynth` + a user-installed SoundFont |
| Timed chord highway | Working for MIDI/timed songs |
| Wait-for-me mode | Present for timed practice |
| Arbitrary audio import | Research-proven in `experiments/`, not wired into app |
| Automated coverage | Minimal; mostly smoke/demo scripts today |

The previous “Rust port + Tauri UI not started” README status is stale. The
app is now the main product surface.

## SoundFont (backing playback)

Backing-track playback renders MIDI through a General MIDI SoundFont. None is
bundled — good GM banks aren't free to redistribute — so the app resolves one
from disk at runtime. The first time you play a backing track with none
installed, a panel offers a one-click download of
[GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) (free, ~30 MB,
redistributable) into the app data dir.

To use your own instead, set `UKEJAM_SOUNDFONT` to a `.sf2` path, or drop one as
`soundfont.sf2` in the app data dir (the panel shows the exact path and has an
"Open folder" button). Other good free banks: FluidR3_GM, MuseScore MS Basic.
Everything except backing playback works without a SoundFont.

## Product Shape

```
          IMPORT                         PRACTICE

 paste tab / ChordPro ─┐
 MIDI file ────────────┼─> ChordPro song + timing ─> library ─> chord highway
 audio file (research) ┘                                      + lyrics / strip
                                                                + backing track
                                                                       │
                                                     mic ─> FFT/chroma detector
                                                                       │
                                             expected chord vs heard notes
                                                                       │
                                        ┌──── clean / missing / extra (instant)
                                        │
                                        └──> one graded verdict per bar
                                                  │            │
                                    highway trail,│            │ windowed digest
                                    strip, score  │            ▼
                                                  │      LLM coach: patterns
                                                  ▼      across bars
```

Two layers of feedback, deliberately split. Everything the app can compute it
computes locally and shows immediately — the missing note, the bar's HIT / WRONG
/ MISS, whether the strum was early or late. The LLM is asked only for the thing
no local rule can produce: the pattern across a run of bars ("every change into F
is late", "the chorus is solid, the bridge falls apart"). It never re-judges a bar
and never restates the notes, so it can't contradict what the screen already
showed. Coaching fires on section boundaries, when you pause or finish, and when
the last eight bars go badly — never per bar, which would be slower than the
music and thinner than the local feedback already is.

Without a configured AI endpoint, everything except the coach panel works
unchanged.

Songs stay instrument-agnostic: a `G` is stored as a chord name and pitch-class
target, while the app decides how to show that shape in the current tuning.
Detection is chroma-based and so tuning-agnostic too — only the tuner and the
fretboard/voicing layer care which uke you have.

## App

```bash
cd app
pnpm install
pnpm build
pnpm tauri dev
```

Pick your tuning on the Setup screen — Standard (G C E A, i.e. soprano/concert/
tenor) or Baritone (D G B E). The choice persists in `settings.json` in the app
data dir and is applied to both the Rust tuner and the frontend fretboards on
launch.

Useful app checks:

```bash
pnpm --dir app build
pnpm --dir app verify:voicings
pnpm --dir app verify:verdicts
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo check --manifest-path app/src-tauri/Cargo.toml --examples
```

`verify:voicings` re-derives every hand-written chord shape in `main.ts` from
the chord's pitch classes and fails if a shape misses a chord tone or sounds a
note that isn't in the chord. A wrong fret is invisible in the UI — it just
teaches the wrong chord — and the first run caught 16 bad standard-tuning
shapes, so run it after touching the tables.

`verify:verdicts` covers the per-bar scorer in `app/src/verdict.ts`: the grading
rule, the MISS-vs-WRONG split, timing signs, and the digest the coach is built
from. The grading rule (all target notes present, at most one extra) is shared
with `isCleanHit()` in `main.ts` and `scorer.py` in the prototype — these tests
pin it so changing one has to be a deliberate change to all three. A wrong
verdict is worse than none: it tells the player a chord they got right was wrong,
and hands the coach facts that contradict the screen.

### AI endpoint

Both AI features — ✨ tab enhance and the practice coach — go through one
OpenAI-compatible endpoint set on the Setup screen, called from Rust so the key
never reaches the webview. The coaching model can be set separately from the
enhancement model (they have very different shapes: one short turn you're waiting
on mid-song, versus one long offline conversion), and `UKEJAM_PROXY_URL`,
`UKEJAM_PROXY_KEY`, and `UKEJAM_COACH_MODEL` override the saved values at request
time.

### iOS

The app targets iOS through Tauri 2's mobile support. The iOS-specific pieces
are already in the tree:

- `app/src-tauri/src/ios_audio.rs` configures `AVAudioSession`
  (playAndRecord + speaker/bluetooth routing) before every cpal stream start —
  without this an iOS build records nothing and plays through the earpiece.
  It also installs the interruption and route-change observers (below) and
  drives `UIApplication.isIdleTimerDisabled`.
- The screen stays awake while the mic is listening or a backing track is
  playing, and only then: the frontend derives one boolean from
  listening/detecting/playing and calls `set_keep_awake` when it flips, so the
  idle timer comes back the moment practice stops.
- `app/src-tauri/Info.plist` carries the required `NSMicrophoneUsageDescription`
  and is merged into the generated Xcode project.
- The song library persists to a JSON file in the app's data dir (not webview
  localStorage, which iOS can evict under disk pressure).
- ✨ AI enhance has no localhost proxy on a phone; point it at any reachable
  OpenAI-compatible endpoint from the Setup screen (persisted in
  `settings.json` in the app data dir).
- The UI collapses to a single scrolling column below 860 px and respects
  notch/home-indicator safe areas.

Building requires a Mac with Xcode (plus an Apple Developer account for
devices/TestFlight):

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cd app
pnpm install
pnpm tauri ios init   # generates the Xcode project under src-tauri/gen/apple
pnpm tauri ios dev    # run on simulator or a plugged-in device
pnpm tauri ios build  # archive/IPA
```

Xcode does the final link against the Rust static lib, so the audio system
frameworks cpal needs (CoreAudio, AudioToolbox, plus AVFoundation for the
session glue) are declared in `tauri.conf.json > bundle > iOS > frameworks` —
cargo-side link flags don't survive into a `.a`. If that list changes after
the project was generated, delete `src-tauri/gen/apple` and re-run
`pnpm tauri ios init` (undefined `_AudioComponent*` / `_AudioUnit*` symbols at
link time mean the generated project predates the list).

Note the simulator has no useful mic input — test the tuner/detector on a real
device.

Interruptions (phone call, Siri, alarm) and route changes (unplugged
headphones) are handled natively: `install_observers` watches
`AVAudioSessionInterruptionNotification` and
`AVAudioSessionRouteChangeNotification`, re-activates the session when the
interruption ends, and emits `audio_interruption` / `audio_route_change` to the
webview. The frontend resumes mic listening by itself but deliberately leaves
backing playback paused — silently restarting audio in the user's ear after a
call is worse than a paused transport they can see.

## Python Prototype

Setup:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Smoke scripts:

```bash
.venv/bin/python test_synthetic.py
.venv/bin/python feedback.py
.venv/bin/python robustness.py
.venv/bin/python scorer.py
```

Current observed results in this workspace:

- `scorer.py` behaves as intended on injected mistakes.
- `robustness.py` confirms headphone/backing isolation is still the reliable
  mode; speaker mix remains weak.
- `test_synthetic.py` currently reports **5/7**, not the old README's 7/7
  claim. The misses are extended/ambiguous chords (`A7`, `Dmaj7`).

## Important Files

| Path | Role |
|------|------|
| `app/src/main.ts` | Main frontend state/UI: views, library, import, practice flow |
| `app/src/song.ts` | TypeScript ChordPro/tab parser |
| `app/src/midi.ts` | Dependency-free SMF parser + timed chord chart generation |
| `app/src/library.ts` | Song library (persists via Rust to app-data `library.json`) |
| `app/src-tauri/src/ios_audio.rs` | iOS `AVAudioSession` setup (no-op elsewhere) |
| `app/src-tauri/src/audio.rs` | Mic capture, tuner, chroma chord detector |
| `app/src-tauri/src/chords.rs` | Chord templates, pitch classes, missing/extra diff |
| `app/src-tauri/src/backing.rs` | MIDI backing playback through `rustysynth` |
| `app/src-tauri/src/enhance.rs` | Local OpenAI-compatible proxy calls for tab cleanup |
| `chords.py` | Python detector reference |
| `feedback.py` | Python missing/extra feedback reference |
| `scorer.py` | Python play-along scoring loop |
| `robustness.py` | Backing-track bleed characterization |

## LLM Proxy

Tab cleanup uses a local OpenAI-compatible endpoint:

```text
http://localhost:4000/v1/chat/completions
```

The app calls it from Rust so browser CORS and frontend key exposure are
avoided. If the proxy is down, the UI falls back to saving the raw chart.

The endpoint is configurable: `UKEJAM_PROXY_URL` / `UKEJAM_PROXY_KEY` env vars
win, then the URL/key saved from the app's Setup screen (needed on iOS, where
no localhost proxy exists), then the localhost default above.

## Experiments

`experiments/` is intentionally isolated from the app. It validates whether
ukejam can eventually ingest arbitrary audio files instead of requiring a MIDI
or tab.

Key findings so far:

- Spotify basic-pitch's `nmp.onnx` runs in Burn and matches ONNX Runtime within
  tolerance.
- HTDemucs separates stems through a vendored, Burn 0.21-patched
  `demucs-core`.
- Combined Demucs + basic-pitch on one Burn backend works as an offline import
  pipeline.
- Realtime transcription is not the right goal for that stack: Demucs and
  basic-pitch are non-causal. Keep the current chroma detector for live play
  feedback; use Demucs/basic-pitch for offline song ingestion.

Useful checks:

```bash
cd experiments/basic-pitch-test
cargo run --release

cd ../demucs-test
cargo run --release
```

Demucs weights are large and should stay out of git.

## Known Gaps

- The README and app state have moved faster than tests. The next hardening
  step should be fixture tests for `song.ts`, `midi.ts`, `backing.rs` MIDI
  filtering, and Rust/Python detector parity.
- Live chord detection still needs more real-instrument tuning across mics,
  strum strengths, muting, and room noise.
- Speaker playback contaminates mic input. Headphones/backing isolation should
  remain the default practice path.
- The frontend library is currently `localStorage`; a native persisted store is
  still a likely app milestone.
- Extended chord naming and simplified playable chord naming can diverge,
  especially from MIDI extraction.

## Direction

The practical target is:

1. Make adding a playable song fast.
2. Prefer timed MIDI/imported charts when available.
3. Let the user choose backing instruments, usually bass + drums.
4. Show current and upcoming chord shapes clearly enough to play without
   reading the whole screen.
5. Keep live feedback causal and low-latency.
6. Add offline audio ingestion once the import flow is stable.
