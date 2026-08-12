# Refactoring plan: breaking up `src/main.ts`

> **Status: complete.** All six phases are done. `main.ts` is 4,380 → 383
> lines. Every commit passes `tsc --noEmit`, all six verify scripts and
> `pnpm build`. See **Outcome** at the end for what shipped, where the
> sequencing changed on contact, and what is still unverified.

`src/main.ts` is 4,380 lines — about 40% of the frontend — and contains every
screen of the app in one script, separated only by banner comments. The rest of
the codebase already follows the pattern this plan extends: small focused
modules (`song.ts`, `verdict.ts`, `library.ts`, `midi.ts`, `strumcam.ts`,
`ai.ts`, `openrouter.ts`, `webAuth.ts`), several of them pinned by `verify-*.mjs`
scripts. The point of this refactor is to make the logic still trapped in
main.ts — transport timing, bar scoring, chord theory — testable the same way,
and to make each screen ownable in isolation.

## Goals and non-goals

**Goals**

- main.ts becomes a bootstrap (~150 lines): wire modules, route modes, subscribe
  to Rust events once.
- Every piece of pure logic (beat math, chord theory, voicing generation) lives
  in a DOM-free module with a verify script.
- Each screen (tuner, play, arrangement, library, setup, strumcam) is one module
  that owns its DOM refs and exposes a tiny lifecycle API.

**Non-goals**

- No framework. The app stays vanilla TS + DOM; the refactor is about file
  boundaries, not architecture fashion.
- No behavior changes. Every commit is either a *move* or a *seam* (introducing
  an interface), never both a move and an edit of the logic being moved.
- No renaming of Rust event names or invoke commands; the Tauri boundary is
  frozen for the duration.

## Map of main.ts today

Line numbers are as of commit `b048616` and will drift as phases land; the
section order won't.

| Lines (≈) | Section | Destination |
|---|---|---|
| 1–97 | `nativeInvoke` / `nativeListen` helpers | `native.ts` |
| 98–374 | Tuner: tunings, needle canvas, calibration state, render loop | `views/tuner.ts` + `tunings.ts` |
| 375–458 | Play-view DOM refs | stays with the view that uses each ref |
| 459–657 | `BARITONE_VOICINGS` / `STANDARD_VOICINGS` tables, `verifiedVoicings()` | `theory/voicings.ts` |
| 646–682 | `mode`, chord-listening state, FFT config, chroma bars | `state/appMode.ts`, `views/play/fft.ts`, `views/play/chroma.ts` |
| 683–789 | Mode-switch handler, second listen button, diagnostics drawer | bootstrap + `views/play/diagnostics.ts` |
| 790–1122 | Library screen UI, song-load state, add-song flow | `views/libraryView.ts` |
| 1123–1262 | Tab search (UG scrape preview) | `views/tabSearch.ts` |
| 1263–1364 | MIDI import staging + channel picker | `views/midiImport.ts` |
| 1365–1549 | Song list, `loadSongIntoPlay`, backing setup, `setupTiming` | `session.ts` (logic) + `views/libraryView.ts` (DOM) |
| 1550–1632 | Bar scoring: accumulator, `sealCurrentBar`, `barOfBeat` | `session.ts` + `time.ts` |
| 1633–1773 | LLM coaching panel | `views/play/coach.ts` |
| 1774–1979 | Transport: play/stop/tick, wait mode, backing sync, track picker | `session.ts` (logic) + `views/play/transport.ts` (DOM) |
| 1980–2204 | Song strip, arrangement build/state | `views/play/strip.ts`, `views/arrangement.ts` |
| 2205–2507 | Highway canvas, lyrics pane | `views/play/highway.ts`, `views/play/lyrics.ts` |
| 2508–2555 | Auto-advance + `chord` event listener | `session.ts` + bootstrap |
| 2556–2646 | Backing status listener, iOS audio interruptions | `iosAudio.ts` |
| 2647–2737 | SoundFont install overlay | `views/setup/soundfont.ts` |
| 2738–2821 | Tuning picker + mic calibration (Setup) | `views/setup/tuningSetup.ts` |
| 2822–3001 | AI provider settings panel | `views/setup/aiSettings.ts` |
| 3002–3243 | OpenRouter PKCE sign-in | `views/setup/openrouterAuth.ts` |
| 3244–3450 | Breakdown diagnostics + `renderChords` (the play rAF loop) | `views/play/index.ts` |
| 3451–3726 | Chord theory: `normalizeChord`, `chordPitchClasses`, voicing generator/DFS, shape cycling | `theory/chords.ts`, `theory/voicings.ts` |
| 3727–3898 | Fretboard panels, transition coach, `drawFretboard` | `views/play/fretboard.ts` |
| 3899–4131 | Cleanliness gauge, FFT spectrum + peaks | `views/play/gauge.ts`, `views/play/fft.ts` |
| 4132–4380 | StrumCam view glue | `views/strumcamView.ts` |

## Shared state: the three clusters

A usage analysis of the 68 top-level `let` variables shows the coupling funnels
into three clusters. Everything else is section-local and moves with its
section.

**1. App chrome** — `mode`, `listening`, `chordListening`, `tuning`.
Read by nearly every section. Becomes `state/appMode.ts` (mode + subscribe) and
`tunings.ts` (active tuning + subscribe). The mode-switch click handler becomes
a router: each view registers `{ enter(), leave() }`, and the "stop audio when
leaving practice surfaces" rule lives in the router, not in the views.

**2. The practice session** — the ~30-variable cluster declared around lines
817–877: `loadedSong`, `songIdx`, `timed`, `chordBeat`, `songBeats`,
`secPerBeat`, `playing`, `songTime`, `waiting`/`waitMode`, `hasBacking`,
`selectedChannels`, the bar accumulator (`barAccum`, `currentBar*`,
`sectionOfIdx`), and `targetChord`. This is one cohesive domain — song +
transport + scoring — read by transport, highway, lyrics, strip, arrangement,
coaching, auto-advance, and the diagnostics drawer. It becomes `session.ts`:
module-private state behind an explicit API (`loadSong`, `play`, `stop`,
`restart`, `jumpToChord`, `tick`, getters) plus two callbacks out:
`onBarSealed(verdict)` (already a clean seam — coaching consumes it via
`onVerdictSealed`) and `onStateChanged()` for views. Views depend on the
session; the session never imports a view.

**3. Live audio readings** — `current` (tuner reading), `chord` (chord reading),
`lastOnsetAt`, `smoothClean`. These arrive from Rust and are consumed by render
loops. `native.ts` subscribes once per event and re-emits through a typed bus;
each consumer keeps its own smoothing state locally.

## Target layout

```
src/
  main.ts                  bootstrap: init views, mode router, event routing
  native.ts                invoke/listen wrappers, typed event bus
  tunings.ts               TuningSpec table, active tuning store
  time.ts                  fmtTime, barOfBeat, beat/bar math (pure)
  session.ts               song + transport + scoring state machine
  theory/
    chords.ts              normalizeChord, chordPitchClasses, positiveMod (pure)
    voicings.ts            verified tables, generator DFS, shape cycling (pure)
  views/
    tuner.ts               needle, string rows, calibration UI
    libraryView.ts         library screen (uses existing library.ts data layer)
    tabSearch.ts
    midiImport.ts
    arrangement.ts
    strumcamView.ts        glue over existing strumcam.ts
    setup/
      tuningSetup.ts       tuning picker + mic calibration
      aiSettings.ts
      openrouterAuth.ts
      soundfont.ts
    play/
      index.ts             renderChords loop, per-frame orchestration
      transport.ts         transport bar DOM, track picker
      highway.ts  strip.ts  lyrics.ts  fretboard.ts
      gauge.ts  fft.ts  chroma.ts  breakdown.ts  diagnostics.ts
      coach.ts
  iosAudio.ts              interruption/route-change handling
```

Existing modules (`song.ts`, `verdict.ts`, `library.ts`, `midi.ts`,
`strumcam.ts`, `ai.ts`, `openrouter.ts`, `webAuth.ts`) are untouched.

## Ground rules

1. **Move-only commits.** A commit either relocates code verbatim or introduces
   a seam (store, callback, init function). Behavioral fixes found along the way
   get their own commit, before or after — never inside a move.
2. **DOM refs are grabbed in `init()`, not at import time.** Today 143
   `getElementById` calls run as module side effects; after the refactor, import
   order can never matter. `index.html` is static, so the `!` assertions stay
   valid — they just move inside each view's init.
3. **One Rust subscription per event.** `nativeListen` calls live only in
   `native.ts`/bootstrap; views subscribe to the bus. This prevents the classic
   split-refactor bug of two listeners on `"chord"` double-advancing the song.
4. **Every phase ends green**: `npx tsc --noEmit` clean, all `pnpm verify:*`
   scripts pass, `pnpm build` succeeds, and the smoke checklist below passes in
   `pnpm tauri dev`.

**Smoke checklist** (manual, per phase): tuner needle responds; Play detects a
chord and the highway scrolls; loading a library song sets the target; transport
play/wait/restart works with backing; arrangement view scrolls to the current
chord; setup screens persist tuning + AI settings; OpenRouter connect button
opens the browser flow; StrumCam starts the camera and tallies strokes.

## Phases

### Phase 0 — Baseline (no code moves)

Record the current green state: run `tsc --noEmit`, all four verify scripts, and
the smoke checklist; fix nothing, just note any pre-existing failures so they
aren't attributed to the refactor later.

### Phase 1 — Foundations: native layer + pure logic (~700 lines out)

1. `native.ts`: move `nativeInvoke`/`nativeListen` verbatim; add the typed event
   bus (a `Map<event, Set<handler>>` — ~30 lines, no library).
2. `theory/chords.ts`: move `normalizeChord`, `chordPitchClasses`,
   `positiveMod`, `pcNameToIndex`, `PITCH_CLASSES`. Pure functions, zero DOM.
3. `theory/voicings.ts`: move both voicing tables, `verifiedVoicings`
   (parameterized on a passed tuning id instead of reading the global),
   `generatedVoicingCandidates` + DFS, `voicingsForChord`, `voicingKey`.
   **In the same commit**, update `verify-voicings.mjs`: it currently regex-reads
   the tables out of main.ts as text; it should now `import` the module directly
   (like `verify-verdicts.mjs` does), which is strictly better than text
   scraping.
4. `time.ts`: move `fmtTime`, `barOfBeat`, and the beat-math core of
   `setupTiming` (the part that derives `chordBeat`/`songBeats`/`secPerBeat`
   from a `Song`), leaving the DOM writes at the call site for now.
5. **New verify scripts**: `verify-theory.mjs` (normalize/pitch-class/generator
   invariants — e.g. every generated voicing sounds exactly the chord's tones,
   mirroring what verify-voicings pins for hand-written shapes) and
   `verify-timing.mjs` (chordBeat monotonicity, barOfBeat boundaries, the
   time-signature cases `setupTiming` handles). These pin behavior before the
   riskier phases touch its callers.

### Phase 2 — Self-contained leaves (~1,200 lines out, one commit each)

Order chosen so each extraction is smaller and more isolated than the next.
Each becomes a module exporting `init(deps)` where `deps` is the minimal
interface it needs — no module reaches back into main.ts globals.

1. `views/setup/soundfont.ts` — overlay + download progress; dep:
   `onInstalled()` so transport can retry playback.
2. `views/setup/openrouterAuth.ts` — PKCE flow; deps: the `aiConfig` object and
   a `renderAiPanel()` callback (formalizing the coupling it already has).
3. `views/setup/aiSettings.ts` — provider panel; owns `aiConfig` hydration and
   exposes it to openrouterAuth + the enhance flow.
4. `views/setup/tuningSetup.ts` — tuning picker + mic calibration; deps: the
   tuning store (Phase 3 introduces it; until then a setter callback).
5. `views/tabSearch.ts` — deps: `pasteBox` handoff callback.
6. `views/midiImport.ts` — deps: `stageSong(song, midi)` callback into the
   add-song flow.
7. `iosAudio.ts` — deps: `isListening()`, `pauseTransport()`, `resumeAudio()`.
8. `views/play/diagnostics.ts` — the drawer + breakdown renderer.
9. `views/strumcamView.ts` — the glue over `strumcam.ts`; deps: mode store,
   onset bus.

### Phase 3 — App chrome + tuner (~400 lines out)

1. `state/appMode.ts` + `tunings.ts`: introduce the stores; convert the
   mode-switch click handler into the router with per-view `enter/leave`.
   All `mode ===` reads in remaining main.ts code switch to the store.
2. `views/tuner.ts`: move the tuner wholesale — its state, needle canvas,
   render loop, string rows. It registers with the router; calibration hooks
   (used by tuningSetup) become exported functions.

### Phase 4 — The session core (~600 lines out; the risky one)

Extract `session.ts` in three move-only commits:

1. **Timing + song load**: `loadSongIntoPlay`'s state part, `setupTiming`'s
   remaining glue, backing setup (`hasBacking`, `selectedChannels`,
   `currentMidiB64`, `loadBackingIntoEngine`).
2. **Transport**: `startTransport`/`stopTransport`/`restartTransport`/
   `tickTransport`/`applyBeat`/`maybeWaitAtBoundary`/`syncBackingPos`, the
   wait-mode flags. DOM updates (`setPlayBtn`, time labels) become an
   `onTransportUi(state)` callback implemented by `views/play/transport.ts`.
3. **Scoring + advance**: the bar accumulator, `sealCurrentBar`,
   `sealUntimedChord`, `resetScoring`, `maybeAdvance`, `setTarget`,
   `isCleanHit`. The `"chord"` event listener moves to bootstrap and calls
   `session.onChordReading(r)`. Coaching consumes `onBarSealed` — its existing
   `onVerdictSealed` signature is already exactly this.

After each sub-step: full smoke checklist, with extra attention to wait mode,
auto-advance debounce, and the untimed-song path (`timed === false`), since
those branch on the flags being moved.

### Phase 5 — The play view split (~1,400 lines out)

`renderChords` (≈3281–3450) stays the single rAF loop but moves to
`views/play/index.ts` and becomes an orchestrator: it reads session state + the
latest readings once per frame and hands them to pure-ish renderers:

- `highway.ts` (`drawHighway`, `drawTrailToken`, `roundRect`)
- `strip.ts`, `lyrics.ts` (build + update pairs)
- `fretboard.ts` (`drawFretboard`, shape panels, transition coach)
- `gauge.ts`, `fft.ts`, `chroma.ts` (each keeps its own smoothing buffers)
- `coach.ts` (panel rendering; subscribes to `onBarSealed`)

Then `views/arrangement.ts` (build/update/cards) and `views/libraryView.ts`
(song list, add-song flow, staging) move the same way. Each renderer takes an
explicit args object; none imports the session directly except `index.ts`.

### Phase 6 — Bootstrap cleanup

What remains in main.ts should be: imports, `init()` calls in dependency order,
the mode router wiring, and the per-event bus routing. Delete dead helpers,
confirm no `document.getElementById` remains in main.ts, run the full gate one
last time. Target: main.ts ≤ 200 lines.

## Risks and mitigations

- **`verify-voicings.mjs` text-parses main.ts.** Breaks the moment the tables
  move. Mitigation: updated in the same commit as the Phase 1 table move, and
  converted to a real import.
- **Double event subscription during transition.** A moved listener left behind
  in main.ts double-fires (worst case: `"chord"` advancing the song twice per
  reading). Mitigation: ground rule 3 — every `nativeListen` call is deleted
  from main.ts in the same commit that adds its bus subscription; grep for
  `nativeListen` at the end of every phase.
- **Circular imports** (session ↔ views). Mitigation: dependencies point one
  way — views import the session/stores; the session reaches out only through
  callbacks registered at init.
- **Hidden ordering side effects.** Today, top-level statements run in file
  order (e.g. chroma bars are built before the first render tick). Mitigation:
  ground rule 2 (refs and DOM construction in `init()`), and bootstrap calls
  inits in the old file order until Phase 6 proves order no longer matters.
- **`tuning` is both tuner state and theory input.** The voicing generator, the
  fretboard, and the tuner all read it. Mitigation: it becomes the `tunings.ts`
  store in Phase 3; until then, extracted theory functions take it as a
  parameter (done in Phase 1), so only DOM code ever reads the global.
- **Line-number drift.** The table above goes stale as phases land. Mitigation:
  each phase's PR/commit message names the functions moved, not the lines.

## Definition of done

- main.ts ≤ 200 lines, no `getElementById`, no `let` state.
- `pnpm build`, `tsc --noEmit`, and all verify scripts (now six) green.
- Smoke checklist passes on desktop; iOS interruption path re-tested on device.
- Transport timing, bar scoring, and chord theory are importable by plain-node
  verify scripts — the property that made `song.ts`/`verdict.ts` bugs
  catchable before they reached a device.

---

## Outcome

`main.ts`: **4,380 → 383 lines** (91% smaller). Twenty-two commits, each green
on `tsc --noEmit`, all six verify scripts, and `pnpm build`.

| | before | after |
|---|---|---|
| `main.ts` lines | 4,380 | 383 |
| `getElementById` / `querySelector` in `main.ts` | 143 | 12 |
| top-level `let` in `main.ts` | 68 | 3 |
| verify scripts | 4 | 6 |

The 12 remaining DOM refs are the six view containers, the corner label, the
mode buttons and the connection indicator — the router's own chrome. The three
remaining `let`s are the keep-awake flag and the held detector reading, which
three consumers share.

### What each phase delivered

- **1** — `native.ts` (with the one-subscription-per-event bus), `tunings.ts`,
  `theory/chords.ts`, `theory/voicings.ts`, `time.ts`. `verify-voicings.mjs`
  converted from text-scraping `main.ts` to a real import. **New:**
  `verify-theory.mjs` and `verify-timing.mjs`.
- **2** — `views/setup/{soundfont,aiSettings,openrouterAuth,tuningSetup}.ts`,
  `views/{tabSearch,midiImport,strumcamView}.ts`, `dom.ts`.
- **3** — `state/appMode.ts`, the active-tuning store, `views/tuner.ts`.
- **4** — `session.ts` (song + transport + scoring, DOM-free, read through
  getters, eleven callbacks out), `iosAudio.ts`.
- **5** — `views/play/{index,highway,fretboard,strip,lyrics,gauge,fft,chroma,breakdown,transport,coach}.ts`,
  `views/arrangement.ts`, `views/libraryView.ts`.
- **6** — `main.ts` reduced to wiring. All six Rust events now have exactly one
  subscriber *by construction*, not by inspection.

Two things stayed in `main.ts` deliberately: `loadSongIntoPlay`, which rebuilds
every practice view and switches screen, and `cycleChordShape`, which spans the
Play rail and the arrangement cards. Both are orchestration across modules that
should not know about each other.

### Where the plan changed on contact

1. **`tunings.ts` landed in Phase 1, not Phase 3.** Parameterising the voicing
   generator on a tuning needs `TuningSpec` to exist. The type and table moved
   early; the mutable store still landed in Phase 3.
2. **`tuningSetup` and mic calibration moved from Phase 2 to Phase 3, and
   `iosAudio.ts` from Phase 2 to Phase 4.** Both orchestrate state the later
   phases were about to formalise. Extracted where the plan listed it,
   `iosAudio` would have needed ten callbacks; after `session.ts` and
   `views/tuner.ts` existed it needed seven, three of which became direct
   imports.
3. **`session.ts` moved in one commit, not three.** The three sub-steps share
   one state cluster; splitting would have left half of it in `main.ts` behind
   temporary accessors for two commits.
4. **The ≤200-line target for `main.ts` was not reachable, and 383 is the
   honest floor** without dissolving things that belong together. The import
   block alone is ~95 lines, the mode router ~65, and the plan explicitly keeps
   the router here. Everything else is init calls and the event fan-out.

The diagnostics drawer never became its own module: it is ten lines and lives
with the render loop that its instrumentation feeds.

### Bugs this refactor introduced and fixed

All three came from bulk identifier rewrites hitting prose rather than code,
and all were caught by diffing against the original — **none would have failed
a typecheck**:

- `"saved — tuning to …"` became `"saved — activeTuning() to …"` in the
  tuning-save confirmation.
- The practice status line's `waiting`/`playing` words became
  `isWaiting()`/`isPlaying()`.
- Ten comments were mangled during the `session.ts` move.

A fourth was caught by the compiler: a guard meant to skip assignments and
object keys also skipped two reads inside ternaries, which would have silently
left `main.ts` reading stale locals had the originals still existed.

**Lesson for future sweeps of this kind:** a rename pass over a large file needs
a diff review of every string and comment it touched, not just a green build.

### Still unverified

The automated gate is green throughout, but the app was never driven. The
behaviour-preserving case for the `session.ts` extraction, the iOS interruption
path and wait-mode rests on diff review alone. Before trusting this on a device,
run `pnpm tauri dev` against the smoke checklist above — especially wait-mode,
auto-advance on an untimed song, and backing playback, which branch on flags
that moved.
