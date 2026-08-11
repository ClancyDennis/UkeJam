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
| Onset (strum) detection | Working: spectral flux, rising-edge gated; validated on real audio |
| StrumCam (camera direction lab) | Working: in-app view; frame-difference motion fused with mic onsets |
| Per-bar scoring | Working: HIT / WRONG / MISS per bar, with strum timing |
| Rhythm scoring | Working: strums per bar and how many landed on the beat grid |
| Live practice coaching | Working: graded bars → AI advice across bars (needs a provider) |
| Chord diagrams | Working: verified shape tables per tuning, generator fallback |
| Song library | Working as JSON in the app data dir; Python prototype uses SQLite |
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
                                        ┌──── clean / missing / extra (instant)
                                        │
                                        └──> one graded verdict per bar
                                                  │            │
                                    highway trail,│            │ windowed digest
                                    strip, score  │            ▼
                                                  │      LLM coach: patterns
                                                  ▼      across bars
```

### Rhythm

Alongside the chord verdict, each bar records **how it was strummed**: how many
attacks it got, and how many landed on the rhythmic grid (beats and the half-beats
between them, since that is where real strumming patterns live). Chord and rhythm
fail independently — a player can hold a perfect Am and strum it once where the bar
wanted four — and for a beginner the rhythm is often the more useful thing to hear.

Unlike strum *direction*, this works everywhere: it needs only that an attack
happened, not which string sounded first, so there is no trackable-string gating, no
tuning dependence, and no "unknown" state.

Two things are deliberately **not** claimed, because the app cannot support either
without knowing the song's strumming pattern (the `Song` model has no pattern field):

- **Whether the strum count was right.** Half notes, eighths and syncopation are all
  correct playing. A first pass reported "8/16 strums" at a player strumming sensible
  half notes — scolding correct playing, which is how a practice tool loses trust.
- **Whether a strum was early or late.** On a half-beat grid, a strum 130 ms after a
  beat is equally "130 ms late for the beat" and "120 ms early for the off-beat" —
  the same event described two ways, indistinguishable without knowing which position
  the player aimed at. The same first pass called four perfectly even eighths
  "rushing".

What survives is how *tight* the time was, which holds for any pattern. If songs ever
carry a declared strumming pattern, both of those become answerable — and that is the
main reason to add one.

Two layers of feedback, deliberately split. Everything the app can compute it
computes locally and shows immediately — the missing note, the bar's HIT / WRONG
/ MISS, whether the strum was early or late. The LLM is asked only for the thing
no local rule can produce: the pattern across a run of bars ("every change into F
is late", "the chorus is solid, the bridge falls apart"). It never re-judges a bar
and never restates the notes, so it can't contradict what the screen already
showed. Coaching fires on section boundaries, when you pause or finish, and when
the last eight bars go badly — never per bar, which would be slower than the
music and thinner than the local feedback already is.

Without a configured AI provider, everything except the coach panel works
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

`cargo test` includes a **real-audio onset regression** (`audio.rs`): 12 strums from
an actual ukulele recording, replayed through the shipped detector at three callback
sizes, asserting the onset count lands near 12. This exists because the detector was
calibrated only against synthetic sines and consequently over-fired on real playing —
one strum counted two or three times, since a scale-free flux ratio inflates ring-out
once its slow baseline decays. Synthetic sines cannot catch that: they don't ring.
The bound is set tight enough to fail on the pre-fix behaviour (16–17 onsets), and
was verified to do so by disabling the fix.

Every timing feature sits on this count — a bar's strum count, the per-bar timing
offset, any rhythm scoring — so it's worth guarding directly rather than inferring
from downstream symptoms.

`verify:verdicts` covers the per-bar scorer in `app/src/verdict.ts`: the grading
rule, the MISS-vs-WRONG split, timing signs, and the digest the coach is built
from. The grading rule (all target notes present, at most one extra) is shared
with `isCleanHit()` in `main.ts` and `scorer.py` in the prototype — these tests
pin it so changing one has to be a deliberate change to all three. A wrong
verdict is worse than none: it tells the player a chord they got right was wrong,
and hands the coach facts that contradict the screen.

### AI provider

Both AI features — ✨ tab enhance and the practice coach — go through the one
provider picked on the Setup screen: Apple Intelligence (on-device), OpenRouter, or
any OpenAI-compatible endpoint. Calls are made from Rust so the key never reaches
the webview and there is no browser CORS against arbitrary endpoints.

Coaching deliberately shares that provider rather than having its own model
setting. An earlier version had one, reasoning that coaching is a short turn the
player waits on mid-song while tab conversion is a long offline job — but on-device
Apple Intelligence is already fast, and a second model field is a knob most players
would never touch.

`UKEJAM_PROXY_URL` and `UKEJAM_PROXY_KEY` still override the saved values at request
time for the OpenAI-compatible provider.

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

## Strum Direction (feasibility study)

The app knows *when* you strummed (onset detection) but not which way your hand
moved. Direction is the missing half of rhythm coaching — "your upstrokes are
dragging" is exactly the cross-bar pattern the coach exists to surface.

The proposed method reads the order the strings sound in: a downstroke sweeps
string 4 → 1, an upstroke 1 → 4. Compare the observed order against those two
templates and you have the direction.

**The combinatorics work.** `strum_model.py` reads the app's own verified voicing
tables out of `main.ts` and checks every shape:

```bash
.venv/bin/python strum_model.py
```

All 244 shapes are decidable — 76% from the first attack, the remaining 24% from
the second, none ever ambiguous. The 24% are first-position standard-tuning shapes
(`Am`, `F`, `D`, `A`, `Bm`…) where string 4 and string 1 land on the *same pitch*.
That unison is symmetric between the two templates, so it cancels: you don't need
to know which string made a pitch, only what order the pitches arrived in.

**The physics also works** — measured on a real baritone, 46 strums at 60 bpm
(`A` and `C`, downstrokes):

| | |
|---|---|
| Median inter-string stagger | **~10 ms** |
| Correct when it commits | **100%** (0 wrong of 19, offline pass) |
| Commits on | **80%** of strums |
| Method needs | 4 ms to commit; ~2.8 ms floor |

Real playing staggers the strings roughly 2.5× more than the method needs, so the
approach is viable. Two caveats carry forward into the implementation:

- **Shape matters.** `A` tracks all four strings — three ordered pairs, so one
  mis-ordered pair gets outvoted. `C` tracks two: a single pair, with nothing to
  outvote it. The one wrong call in the live session was a `C`. Direction detection
  should probably be gated on trackable-string count rather than offered on every
  shape.
- **Level matters.** Two of the three live wrong calls were on strums the rig had
  already flagged `QUIET`. Excluding those, live accuracy was 97%.

An earlier session appeared to *fail* the gate — 2.3 ms stagger, 8 wrong. It was
played on a baritone while the lab still defaulted to standard tuning, so it was
timing harmonics of the wrong strings (see the tuning warning below). Void, not
evidence — and the reason the tuning is now impossible to overlook.

`ONSET_RATIO = 2.2` in `audio.rs` also looks about right: real audio measured a p95
flux ratio of 2.8.

```bash
.venv/bin/python analyse_strums.py --self-check   # fast path == reference maths
.venv/bin/python analyse_strums.py --synthetic    # known stagger, no uke needed
```

The synthetic pass already found the method's resolution floor, and it is **not**
the estimator: a string sounded alone has its attack located to better than 0.1 ms,
with near-identical latency across the frequency range (so the latency cancels in a
difference). The floor comes from strings sounding *together* — each one's
narrowband envelope picks up its neighbours' leakage and the attack shifts. Measured
at a true 0 ms stagger: C 2.8 ms, G 2.6 ms, Am 1.9 ms, F 0.8 ms.

So the method needs roughly **8 ms** of real stagger to be confident, and reports
*unknown* below that rather than guessing. That was a much higher bar than the ~3 ms
originally assumed — and real playing clears it. **A shorter analysis hop would not
have helped**: the limit is spectral overlap between the strings, not time
resolution.

### StrumCam (in-app camera lab)

The audio method above tops out at ~80% commit and must be gated on chord
shape — worst exactly on the standard-tuning beginner shapes. The camera is the
complementary sensor: a strumming hand moves visibly for 100+ ms per stroke, so
even 30 fps reads direction on essentially every strum — but it can't time
string contact. The split in the app is therefore strict: the **mic** says
*when* (the proven onset detector), the **camera** only answers *which way the
hand was moving at that instant*.

The first cut is deliberately ML-free: `app/src/strumcam.ts` tracks the
vertical velocity of the frame-difference motion centroid on a 64×48 luma grid
— the strumming hand is the dominant mover in a sensibly framed shot. No model
download, no WASM, no webview integration risk; if the simple signal proves
insufficient on real hands, a landmark tracker (e.g. MediaPipe Hands) can
replace `MotionField` behind the same `MotionSample` stream without touching
the fusion or the UI.

The **StrumCam** view (util bar → ◉ StrumCam) is the in-app feasibility rig,
same philosophy as the Python strum lab below: camera preview with the motion
centroid drawn on it, the velocity trace with every mic onset marked, a
per-strum call list carrying its evidence (speed, sign agreement, frame count),
and a running tally. As with the audio study, watch the **wrong** calls, not
the unsure ones — unknown draws no arrow. It also counts **ghost strokes** —
the hand swept but no string sounded — which a microphone cannot see by
definition, and which is exactly how strumming rhythm is taught ("keep the hand
moving, miss the strings on the silent beats"). A `⇅ flip` toggle covers
rotated mounts, where every call would otherwise come out backwards.

`pnpm --dir app verify:strumcam` drives the analysis core with synthetic frames
of known motion: down/up sweeps at known speed, stillness, hover jitter (must
read "unsure", never a coin flip), and direction-at-the-onset beating
biggest-motion-in-history.

Camera + mic run together only on this screen for now; nothing camera-derived
feeds practice scoring yet — that graduation depends on the numbers this view
produces on a real player.

### Strum lab (live, browser)

The interactive way to run the study — play into the mic and watch each strum get
measured:

```bash
.venv/bin/python strum_lab.py --tuning baritone --self-test   # verify the rig
.venv/bin/python strum_lab.py --tuning baritone               # localhost:8766
```

**Set the tuning to your actual instrument.** Getting it wrong does not fail
loudly — it is the one mistake that manufactures confident nonsense. A baritone C
sounds E3 G3 C4 E4, but the standard-tuning probes look for G4 392 Hz and C5 523 Hz,
which are the *second harmonics* of G3 and C4. So the probe meant to fire last
watches a string struck third, the order comes out reversed, and **every downstroke
reads as an upstroke** with a healthy confidence margin. The selector is in the page
header and the startup banner prints the tuning first for that reason.

Baritone is the better instrument for this study, incidentally: it isn't re-entrant,
so `G`, `D` and `A` give all four strings trackable — three ordered pairs of evidence
instead of the single pair most standard-tuning first-position shapes can offer.

The page shows **the exact fingering to play**, which is the point rather than a
convenience: the analyser picks which frequencies to track *from the voicing table*,
so playing a different `C` shape than the one drawn measures the wrong strings and
produces numbers that look like a physics result and are actually a mismatch. The
diagram greys out any string it must skip (a unison contributes no ordering
information) so you can see the reading rests on two strings, not four.

Per strum it shows the per-string attack times on a shared axis, the direction it
heard, and the confidence margin — plus a running tally **broken out by tempo**,
since speed is what decides whether the stagger clears the leakage floor. Click any
cell in the drill grid to switch shape/tempo; the metronome gives one click per
strum so takes are comparable.

Watch the **wrong** count above all. Unknown is fine — no arrow gets drawn. Wrong
would teach a learner the opposite of what they played.

**Get set up first, then record.** The level meter is live before you start, so you
can fix your distance and gain up front. `● record` captures the session's **raw
audio**, not just the measurements, which is what makes the recording worth taking:

```bash
.venv/bin/python analyse_strums.py clips/lab_C_down_60_*.npy
```

That re-runs the same performance through the current code. Every threshold in this
study is a guess until it meets a real ukulele, and without the samples each new
guess costs another take. Each session writes three files to `clips/`: `.npy` (audio),
`.meta.json` (shape, direction, tempo, tuning) and `.strums.jsonl` (the measurements
as they were made). Every strum is also printed to the terminal as it happens, so a
run always leaves a record you can point at.

**Watch the level.** Strums below peak 0.30 are flagged `QUIET` and their timing is
not trustworthy — a weak attack has a mushier envelope edge, which inflates the very
stagger the study is measuring. The first real session came in at median peak 0.15
and reported a 2.3 ms median stagger, close enough to the 2.8 ms leakage floor that
there was no way to separate the player from the gain. If more than a third of a run
is quiet, the tally says so instead of letting a gain problem read as a physics
result.

`--self-test` drives the whole capture path with synthetic strums at every tempo,
checking that each strum produces exactly one onset and that the analysis slice has
enough lead-in silence for the attack to be locatable. Both of those broke during
development and neither is visible from the UI — you would just see bad numbers and
blame the ukulele.

### Offline takes

For a fixed set of takes you can re-analyse as the algorithm changes:

```bash
.venv/bin/python record_strums.py --plan          # what to record and why
.venv/bin/python record_strums.py Am down 20      # then Am up, C down/up, F down/up
.venv/bin/python analyse_strums.py 'clips/strums_*.npy'
```

Record `C`/`G` (decidable from the first attack) *and* `Am`/`F` (decidable only from
the second) — the latter is the case most likely to break. Play naturally: an
exaggerated slow sweep produces flattering numbers that won't hold up in real
playing.

Reading the verdict — it gates on **outcomes**, not on stagger alone:

| Outcome | Meaning |
|---|---|
| GATE CLEARED | Rarely wrong and commits often enough to show. Build the detector; use the reported median margin as the confidence floor. |
| PARTIAL | Not wrong when it commits, but unsure too often for a player-facing glyph. Do **not** lower the confidence floor to raise coverage — that converts "unsure" into "wrong". |
| GATE NOT CLEARED | Either confidently wrong, or the real stagger sits at the leakage floor. Don't build on it. |

Being *wrong* is disqualifying (a wrong glyph actively misleads a learner); being
*unsure* is only a coverage limit. The analyser reports those separately for that
reason. A run also reports what `ONSET_RATIO` real audio supports — the shipped
value in `audio.rs` is 2.2, calibrated against synthetic sines only, so that is
worth correcting regardless of what happens with direction.

Recordings land in `clips/` (gitignored) as raw samples, so the analysis can be
re-run as the algorithm changes without playing everything again.

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
| `app/src-tauri/src/enhance.rs` | Provider-routed chat calls (Apple on-device / remote) for tab cleanup and coaching |
| `app/tauri-plugin-local-llm/` | Tauri plugin bridging Apple Foundation Models (iOS Swift plugin + macOS helper) |
| `app/tauri-plugin-web-auth/` | Tauri plugin running OAuth sign-in in the system browser sheet (iOS) |
| `app/src/ai.ts` | AI provider config: persistence + provider registry |
| `app/src/verdict.ts` | Per-bar scoring: HIT/WRONG/MISS, strum timing, coach digest |
| `app/src/strumcam.ts` | Camera strum direction: motion field, per-onset calls, ghost strokes |
| `app/src/verify-strumcam.mjs` | Synthetic-motion checks for the StrumCam analysis core |
| `strum_model.py` | Voicings read from `main.ts`; down/up templates, unison filter |
| `strum_lab.py` | Live strum-direction lab (SSE server, shares the analyser) |
| `strum_lab.html` | Lab page: shape to play, attack timeline, per-tempo tally |
| `record_strums.py` | Records labelled strums for the direction study |
| `analyse_strums.py` | Measures strum stagger; decides whether direction is viable |
| `chords.py` | Python detector reference |
| `feedback.py` | Python missing/extra feedback reference |
| `scorer.py` | Python play-along scoring loop (ported to `verdict.ts`) |
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

- Coverage is still thin. `verify:voicings` and `verify:verdicts` cover the
  voicing tables and the per-bar scorer; `song.ts`, `midi.ts`, `backing.rs` MIDI
  filtering, and Rust/Python detector parity still have no fixture tests.
- Live chord detection still needs more real-instrument tuning across mics,
  strum strengths, muting, and room noise.
- Onset detection is now validated against a real recording (see below), but only
  one instrument in one room. More instruments, mics and playing styles would
  strengthen it.
- Speaker playback contaminates mic input. Headphones/backing isolation should
  remain the default practice path.
- Extended chord naming and simplified playable chord naming can diverge,
  especially from MIDI extraction.
- Strum direction is **validated but not implemented** on the audio side. A real
  baritone staggers the strings ~10 ms, comfortably above the ~4 ms the method
  needs, at 100% accuracy when it commits. The detector in `audio.rs` is the
  remaining work, and it should gate on trackable-string count: four-string
  shapes carry three ordered pairs, two-string shapes carry one and can be
  flipped by a single bad reading.
- The StrumCam motion tracker has **never seen a real hand** — every threshold
  (energy floor, min speed, consistency, window) is a guess until the view's
  tally is run against a player calling their own strokes. The camera path is
  also untested inside the iOS webview (`getUserMedia` needs the
  `NSCameraUsageDescription` now in `Info.plist`; the simulator has no camera
  worth testing with).

## Direction

The practical target is:

1. Make adding a playable song fast.
2. Prefer timed MIDI/imported charts when available.
3. Let the user choose backing instruments, usually bass + drums.
4. Show current and upcoming chord shapes clearly enough to play without
   reading the whole screen.
5. Keep live feedback causal and low-latency.
6. Add offline audio ingestion once the import flow is stable.
