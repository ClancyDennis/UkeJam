# ukejam

ukejam is a play-along practice app for **baritone ukulele**. Load a song, see
the chord timeline, play along, and let the app listen for what is actually
ringing. The feedback is practical: which target notes are present, which are
missing, and which extra notes are getting into the chord.

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
| Live tuner | Working via `cpal` + FFT |
| Live chord detection | Working native Rust port: FFT → chroma → template match |
| Missing / extra note feedback | Working for target chords |
| Song library | Working in frontend `localStorage`; Python prototype uses SQLite |
| Pasted tab / ChordPro import | Working, with AI enhancement (Apple Intelligence on-device, OpenRouter, or any OpenAI-compatible endpoint) |
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
                                                     clean / missing / extra
```

Songs stay instrument-agnostic: a `G` is stored as a chord name and pitch-class
target, while the app decides how to show that shape on baritone uke.

## App

```bash
cd app
pnpm install
pnpm build
pnpm tauri dev
```

Useful app checks:

```bash
pnpm --dir app build
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo check --manifest-path app/src-tauri/Cargo.toml --examples
```

The Rust app currently has no meaningful unit-test coverage, so `cargo test`
mainly proves the crate compiles.

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
| `app/src/library.ts` | Browser-local song library |
| `app/src-tauri/src/audio.rs` | Mic capture, tuner, chroma chord detector |
| `app/src-tauri/src/chords.rs` | Chord templates, pitch classes, missing/extra diff |
| `app/src-tauri/src/backing.rs` | MIDI backing playback through `rustysynth` |
| `app/src-tauri/src/enhance.rs` | Provider-routed chat calls (Apple on-device / remote) for tab cleanup |
| `app/tauri-plugin-local-llm/` | Tauri plugin bridging Apple Foundation Models (iOS Swift plugin + macOS helper) |
| `app/src/ai.ts` | AI provider config: persistence + provider registry |
| `chords.py` | Python detector reference |
| `feedback.py` | Python missing/extra feedback reference |
| `scorer.py` | Python play-along scoring loop |
| `robustness.py` | Backing-track bleed characterization |

## AI Enhance providers

✨ AI enhance (tab cleanup, MIDI chart simplification, lyric fusion) runs
through a provider chosen in the **⚙ Setup** screen:

- **On this device (Apple Intelligence)** — Apple's on-device Foundation
  model via `app/tauri-plugin-local-llm/` (iOS 26+ / macOS 26+ with Apple
  Intelligence enabled). Nothing leaves the device. On macOS the plugin's
  `build.rs` compiles a Swift helper binary best-effort; without the macOS 26
  SDK the build still succeeds and the option reports unavailable
  (`UKEJAM_SKIP_LOCALLLM_HELPER=1` skips it explicitly).
- **OpenRouter** — one-tap PKCE sign-in (Connect OpenRouter navigates the
  webview through openrouter.ai/auth and back; a Rust navigation hook routes
  the redirect into the packaged app), or paste an API key from
  [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). Either
  way, pick any model from its catalog.
- **OpenAI-compatible endpoint** — any base URL speaking the OpenAI chat
  protocol (OpenAI itself, LiteLLM, LM Studio, Ollama, a local proxy). The
  API key is optional for keyless local servers.

The settings persist in the frontend's `localStorage` and travel with each
invoke; the remote calls themselves run in Rust so browser CORS against
arbitrary endpoints is avoided. If the provider is unconfigured or the call
fails, the UI falls back to saving the raw chart.

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
