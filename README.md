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
| In-app tab search | Working: searches Ultimate Guitar from the library screen, in-app WebKit preview window, one-click import; optional ✨ smart mode turns a fuzzy description into searches via the configured AI provider |
| MIDI import | Working: parses SMF, derives timed chord chart, selects chord-source channels |
| MIDI backing playback | Working via `rustysynth` + a user-installed SoundFont |
| Timed chord highway | Working for MIDI/timed songs |
| Wait-for-me mode | Present for timed practice |
| Arbitrary audio import | Research-proven in `experiments/`, not wired into app |
| Automated coverage | Minimal; mostly smoke/demo scripts today |

The previous “Rust port + Tauri UI not started” README status is stale. The
app is now the main product surface.

## Finding tabs in-app

The library screen has a search box that finds chord sheets on Ultimate
Guitar without leaving the app: the Rust side fetches and parses the pages
(the same embedded-JSON approach other open-source tab tools use), results
list in-app, and picking one drops the tab text straight into the paste box —
title and artist prefilled — where the normal ✨ AI-enhance → Add flow takes
over. A "view ↗" button opens the actual tab page in a second Tauri webview
(the system WebKit / WebView2) for eyeballing before importing; that window
gets no IPC access, it's just a sandboxed preview.

The ✨ smart toggle routes the query through the configured AI provider first
(the same Apple Intelligence / OpenRouter / OpenAI-compatible choice as tab
enhancement, from ⚙ Setup), so a loose description ("that whistling uke song
about a mixtape") becomes one to three concrete artist-title searches. If no
provider is set up or the call fails, smart mode silently degrades to a plain
search.

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

### iOS

The app targets iOS through Tauri 2's mobile support. The iOS-specific pieces
are already in the tree:

- `app/src-tauri/src/ios_audio.rs` configures `AVAudioSession`
  (playAndRecord + speaker/bluetooth routing) before every cpal stream start —
  without this an iOS build records nothing and plays through the earpiece.
- `app/src-tauri/Info.plist` carries the required `NSMicrophoneUsageDescription`
  and is merged into the generated Xcode project.
- The song library persists to a JSON file in the app's data dir (not webview
  localStorage, which iOS can evict under disk pressure).
- ✨ AI enhance has no localhost proxy on a phone; pick a provider on the Setup
  screen instead — Apple Intelligence runs on-device, and the cloud options
  reach any server (persisted in `settings.json` in the app data dir, for the
  same eviction reason as the library).
- OpenRouter sign-in uses the iOS system browser sheet, so it gets Safari's
  session, Keychain autofill and passkeys rather than a chrome-less webview.
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
device. Known follow-up: AVAudioSession interruption events (phone calls,
Siri) currently rely on the user restarting listening/playback, which
re-activates the session; a native interruption observer would resume
automatically.

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
| `app/src-tauri/src/enhance.rs` | Provider-routed chat calls (Apple on-device / remote) for tab cleanup |
| `app/tauri-plugin-local-llm/` | Tauri plugin bridging Apple Foundation Models (iOS Swift plugin + macOS helper) |
| `app/tauri-plugin-web-auth/` | Tauri plugin running OAuth sign-in in the system browser sheet (iOS) |
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
- **OpenRouter** — one-tap PKCE sign-in, or paste an API key from
  [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). Either
  way, pick any model from its catalog. The sign-in runs two ways:
  - **iOS** — `app/tauri-plugin-web-auth/` presents an
    `ASWebAuthenticationSession`: a Safari-backed sheet with a Cancel button
    that shares Safari's cookie jar, Keychain autofill and passkeys. The
    plugin opens a loopback listener for the redirect (OpenRouter accepts
    `127.0.0.1` on any port but no custom scheme) and bounces its reply to
    `ukejam-auth://callback`, which is how the sheet knows to dismiss. The
    app is never unloaded.
  - **Browser, dev server, desktop package** — the page navigates through
    openrouter.ai/auth and back with `?code=…`; in the packaged app a Rust
    navigation hook routes the redirect into the app's real origin. This
    path carries the verifier round-trip, stranded-login recovery and
    crash-resume, all of which exist because the app unloads mid sign-in.
- **OpenAI-compatible endpoint** — any base URL speaking the OpenAI chat
  protocol (OpenAI itself, LiteLLM, LM Studio, Ollama, a local proxy). The
  API key is optional for keyless local servers.

The settings persist natively in `settings.json` in the app data dir — not
webview `localStorage`, which iOS can evict under disk pressure, taking a
saved OpenRouter key with it — and travel with each invoke; the remote calls
themselves run in Rust so browser CORS against arbitrary endpoints is avoided.
A config saved before the provider picker landed (a bare `proxy_url`/
`proxy_key`) is migrated up into the OpenAI-compatible provider on first load.
If the provider is unconfigured or the call fails, the UI falls back to saving
the raw chart.

For the OpenAI-compatible provider only, the `UKEJAM_PROXY_URL` /
`UKEJAM_PROXY_KEY` env vars still win over the saved endpoint and key, so an
existing dev machine keeps working without touching Setup.

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
