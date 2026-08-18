// The practice session: the loaded song, the transport clock, the beat grid and
// the per-bar score. One state machine, because they are one thing — which bar
// is open depends on the playhead, which chord is graded depends on the bar,
// and the score has to be dropped whenever the song or the playhead jumps.
//
// Holds no DOM. Everything visible happens through `deps`, so the views can be
// split up without this having to know they exist. The one rule that matters:
// bars are closed in exactly one place (applyBeat), whichever clock is driving
// the playhead, so a bar can never be missed or double-counted depending on
// whether backing audio happens to be playing.

import type { Song } from "./song.ts";
import type { BackingTrackInfo, SongRecord } from "./library.ts";
import { nativeInvoke, type ChordReading } from "./native.ts";
import { chordPitchClasses } from "./theory/chords.ts";
import { barOfBeat, beatsPerBarOf, buildBeatTimeline, isTimedSong } from "./time.ts";
import {
  VerdictBuffer,
  accumulate,
  newAccumulator,
  seal,
  strokesInBar,
  type BarAccumulator,
  type BarVerdict,
  type CameraStrokes,
} from "./verdict.ts";
import { cameraActive, clearStrokes, recentStrokes } from "./strumcamShared.ts";
import { maybeSoundfontError, playBacking } from "./views/setup/soundfont.ts";

export interface SessionDeps {
  /// The most recent chord reading. Wait-mode and auto-advance ask whether the
  /// player is on the chord right now.
  currentReading: () => ChordReading | null;
  /// Play/pause flipped — repaint both transport bars.
  onPlayingChanged: (playing: boolean) => void;
  /// The playhead moved — repaint the time readouts.
  onTimeChanged: (sec: number) => void;
  /// A song's grid was rebuilt: show or hide the transport and set the tempo
  /// labels. `tempo` is 0 for an untimed song.
  onTimingReady: (timed: boolean, tempo: number) => void;
  /// songIdx changed: the strip, lyrics and arrangement follow the target.
  onChordIndexChanged: () => void;
  /// The song has (or hasn't) backing audio; show the mix controls.
  onBackingChanged: (hasBacking: boolean) => void;
  /// A bar was graded. The coach reasons about the bar just closed, so the
  /// verdict is handed over explicitly rather than read back off the buffer.
  onBarSealed: (v: BarVerdict) => void;
  /// Ask the coach for advice at a natural moment ("paused", "song end").
  requestCoaching: (reason: string) => void;
  /// The score buffer was emptied; anything counting bars must reset with it.
  onScoringReset: () => void;
  /// Something a practice screen displays changed (mic state, wait mode,
  /// position, backing).
  onPracticeStateChanged: () => void;
  /// Listening or playing changed; re-evaluate the iOS keep-awake lock.
  syncKeepAwake: () => void;
}

let deps: SessionDeps;

export function initSession(d: SessionDeps): void {
  deps = d;
}


// loaded song state
let loadedSong: Song | null = null;
let loadedRecord: SongRecord | null = null;
let songIdx = 0; // index into chordSequence = current target chord
// The chord the detector is being graded against.
let targetChord = "";
let advanceHold = 0; // frames the correct chord has been held (debounce)

// --- timed-highway transport state ---
// When the loaded song has a real tempo (e.g. a MIDI import), each chord is
// placed at a known beat position so the highway scrolls on a wall clock,
// Rocksmith-style. chordBeat[i] = beat at which chord i begins; songBeats =
// total length. timed===false for plain tabs (no tempo) -> play-to-advance.
let timed = false;
let chordBeat: number[] = []; // beat position of each chord in chordSequence
let songBeats = 0; // total beats (end of last chord)
let secPerBeat = 0.5; // 60/tempo
let playing = false;
let songTime = 0; // seconds elapsed in the song
let lastTickAt = 0; // performance.now() of last transport tick
export const LOOKAHEAD_BEATS = 6; // how many beats ahead the highway shows

// --- per-bar scoring ---
// The detector judges each window in isolation; this turns that stream into one
// graded verdict per bar, which is what both the highway trail and the coach
// read. See verdict.ts for the model and the grading rule.
const verdicts = new VerdictBuffer();
let barAccum: BarAccumulator = newAccumulator();
let beatsPerBar = 4; // set by setupTiming from the song's time signature
let currentBar = -1; // bar ordinal the accumulator is filling (-1 = none yet)
let currentBarChordIdx = 0; // chord the bar was opened on, for the verdict
let currentBarStartedAt: number | null = null; // performance.now() of its downbeat
// Whether wait-mode parked the playhead during this bar. If it did, the strum's
// distance from the downbeat is an artifact of the mode, not the player.
let currentBarWaited = false;
// Section label per chord index, so a verdict knows where in the song it sits
// (and so the coach can be triggered on section boundaries).
let sectionOfIdx: string[] = [];

// backing-track (MIDI audio) state. When a song has backing audio, the Rust
// playback position drives the highway playhead (no drift); otherwise the
// wall clock does. selectedChannels = which MIDI channels sound (bass+drums
// by default — the player covers the rest).
let hasBacking = false;
let backingTracks: import("./library").BackingTrackInfo[] = [];
let selectedChannels: number[] = [];
let currentMidiB64: string | null = null;

// The last latency-compensated position reported by the audio engine, and when
// it arrived. Between events (which arrive every ~50ms of playback) the render
// loop dead-reckons from this anchor, so the playhead moves every frame instead
// of stepping once per event. `playing` is the ENGINE's flag: extrapolation
// must stop the moment the engine is paused (wait-mode, pause), even though our
// transport flag may still be on.
let backingAnchor: { pos: number; at: number; playing: boolean } | null = null;
// Never extrapolate further than this past the anchor: if events stop coming
// (stream died, app backgrounded), the playhead freezes instead of running off.
const BACKING_COAST_MAX = 0.5;

// Whether the detector could actually parse the current target. False for a
// chord name neither side understands (a typo, or a quality we don't support):
// Rust then holds no target, so `missing`/`extra` come back empty, which looks
// exactly like a flawless chord. Everything that grades must check this first.
let targetGradeable = false;


// Wait-mode: hold the playhead at each chord boundary until the player has
// played that chord cleanly, then resume. Encourages smooth, accurate playing.
let waitMode = false;
let waiting = false; // currently paused at a boundary, waiting for the chord

export function setTarget(chord: string) {
  targetChord = chord;
  // Assume ungradeable until Rust confirms it parsed. Optimistic-then-correct
  // would flash a false "Locked in" for a frame on every chord change.
  targetGradeable = false;
  nativeInvoke<boolean>("set_target", { chord: chord || null })
    .then((ok) => {
      // Ignore a stale reply: the player may have moved on while it was in flight.
      if (targetChord === chord) targetGradeable = ok && !!chord;
      deps.onPracticeStateChanged();
    })
    .catch(() => {
      // The call itself failed (no native runtime, or a transient IPC error), so
      // Rust never told us either way. Fall back to our own resolver, which
      // shares its vocabulary: a real chord stays gradeable rather than grading
      // switching itself off silently for the rest of the session.
      if (targetChord === chord) targetGradeable = chordPitchClasses(chord).length > 0;
      deps.onPracticeStateChanged();
    });
  deps.onPracticeStateChanged();
}

export function isCleanHit(reading: ChordReading | null): boolean {
  // No parseable target => nothing was compared => cannot be a hit. Without this
  // guard an empty diff reads as perfect, which auto-advanced the song and
  // scored every bar HIT while the player hadn't touched the strings.
  if (!targetGradeable) return false;
  return !!reading?.active && reading.missing.length === 0 && reading.extra.length <= 1;
}

type NextChordInfo = {
  name: string;
  index: number;
  beatsUntil: number;
  urgency: number;
};

export function nextDistinctChordInfo(): NextChordInfo {
  if (!loadedSong) return { name: "", index: -1, beatsUntil: 0, urgency: 0 };
  const seq = loadedSong.chordSequence;
  let n = songIdx + 1;
  while (n < seq.length && seq[n] === seq[songIdx]) n++;
  if (n >= seq.length) return { name: "", index: -1, beatsUntil: 0, urgency: 0 };

  if (!timed) {
    const stepsUntil = Math.max(1, n - songIdx);
    return {
      name: seq[n],
      index: n,
      beatsUntil: stepsUntil,
      urgency: Math.max(0.22, 0.55 - (stepsUntil - 1) * 0.12),
    };
  }

  const headBeat = songTime / secPerBeat;
  const nextBeat = chordBeat[n] ?? n;
  const beatsUntil = Math.max(0, nextBeat - headBeat);
  const urgency = 1 - Math.min(1, beatsUntil / LOOKAHEAD_BEATS);
  return { name: seq[n], index: n, beatsUntil, urgency };
}

export function nextDistinctChord(): string {
  return nextDistinctChordInfo().name;
}

// Configure backing audio for the loaded song. Default the selection to
// bass + drums (the rhythm section to play over); if the MIDI has neither,
// fall back to all non-lead channels.
export function setupBacking(rec: SongRecord) {
  nativeInvoke("stop_backing").catch(() => {});
  backingAnchor = null; // stale anchors belong to the previous song's stream
  hasBacking = !!rec.midi && !!rec.tracks?.length;
  backingTracks = rec.tracks ?? [];
  currentMidiB64 = rec.midi ?? null;
  if (!hasBacking) {
    deps.onBackingChanged(false);
    deps.onPracticeStateChanged();
    return;
  }
  const rhythm = backingTracks.filter((t) => t.isBass || t.isDrums).map((t) => t.channel);
  selectedChannels = rhythm.length ? rhythm : backingTracks.map((t) => t.channel);
  deps.onBackingChanged(true);
  loadBackingIntoEngine();
  deps.onPracticeStateChanged();
}

// Send the MIDI + selected channels to the Rust synth (paused at start). The
// MIDI travels as base64 (decoded in Rust) — far cheaper over IPC than a JSON
// array of bytes.
export function loadBackingIntoEngine() {
  if (!currentMidiB64) return;
  nativeInvoke("load_backing", { midi: currentMidiB64, channels: selectedChannels }).catch((e) => {
    // no SoundFont installed yet → prompt to download one; otherwise a transient
    // load failure shouldn't tear down the picker, so just log it.
    if (!maybeSoundfontError(e)) console.warn("load_backing failed", e);
  });
}

// Re-filter the already-loaded backing to the current channel selection without
// resending the file — preserves position/play state (used by the track picker).
export function applyChannelSelection() {
  if (!currentMidiB64) return;
  nativeInvoke("set_backing_channels", { channels: selectedChannels }).catch((e) => {
    console.warn("set_backing_channels failed", e);
  });
}

// Build the beat-timeline for the loaded song. With a real tempo + bar markers
// (MIDI import) each chord occupies the bars until the next chord, so chord i
// sits at a known beat. Without tempo, the song is untimed (play-to-advance).
export function setupTiming(song: Song) {
  stopTransport();
  songTime = 0;
  backingAnchor = null;
  resetScoring();
  timed = isTimedSong(song);
  chordBeat = [];
  if (!timed) {
    deps.onTimingReady(false, 0);
    songBeats = 0;
    // Untimed songs score per chord advance, and sealUntimedChord files the
    // chord we're leaving — so open the first one here or chord 0 is never
    // graded (resetScoring left currentBar at -1, meaning "nothing open").
    currentBar = 0;
    currentBarChordIdx = 0;
    deps.onPracticeStateChanged();
    return;
  }
  secPerBeat = 60 / song.tempo;
  beatsPerBar = beatsPerBarOf(song);
  const timeline = buildBeatTimeline(song, beatsPerBar);
  chordBeat = timeline.chordBeat;
  songBeats = timeline.songBeats;
  deps.onTimingReady(true, song.tempo);
  deps.onTimeChanged(0);
  deps.onPlayingChanged(false);
  deps.onPracticeStateChanged();
}

// --- per-bar scoring ---

// Map every chord index to the section it sits in, so a verdict can say "the
// bridge falls apart" rather than just "bar 34". Sections come from {comment:}
// directives, which a lot of songs simply don't have — an empty label is normal.
export function buildSectionMap(song: Song) {
  sectionOfIdx = [];
  let section = "";
  let idx = 0;
  for (const line of song.lines) {
    if (line.section) {
      section = line.section;
      continue;
    }
    for (let i = 0; i < line.chords.length; i++) sectionOfIdx[idx++] = section;
  }
}

export function resetScoring() {
  verdicts.clear();
  barAccum = newAccumulator();
  currentBar = -1;
  currentBarChordIdx = 0;
  currentBarStartedAt = null;
  currentBarWaited = false;
  // Buffered camera strokes go with the verdicts. They are timestamped, so on a
  // restart the first bar's window would otherwise still cover sweeps from the
  // previous attempt and credit them to the new one.
  clearStrokes();
  // Anything counting bars in the buffer we just emptied has to reset with it —
  // otherwise it stays ahead of verdicts.length and the sectionless trigger
  // stops firing for a whole extra window.
  deps.onScoringReset();
}

// Close out the bar the accumulator has been filling and file its verdict.
// `nextBar`/`nextChordIdx` open the following bar in the same step, so the
// downbeat timestamp used for the timing offset is the one we actually crossed.
/// The camera strokes belonging to the bar that just closed, or null when the
/// camera wasn't running for it.
///
/// Null, never an empty array: an empty array claims the hand never moved, which is
/// a judgement about something nobody was watching. Everything downstream — the
/// subtitle, the highway, the coach prompt — keys off that distinction.
///
/// Windowed by timestamp rather than taking whatever has arrived, because a ghost
/// resolves ~340ms after its stroke ends (it is defined by an onset NOT arriving),
/// which is often after this bar has already sealed. Arrival order would silently
/// lose the strokes at the ends of bars.
function cameraStrokesForBar(startedAt: number | null, endedAt: number | null): CameraStrokes | null {
  if (!cameraActive() || startedAt === null) return null;
  // A bar closing with no end timestamp (untimed advance) has no window to slice,
  // so make no claim rather than guessing at one.
  if (endedAt === null) return null;
  return strokesInBar(recentStrokes(), startedAt, endedAt);
}

export function sealCurrentBar(nextBar: number, nextChordIdx: number, at: number | null) {
  let sealed: BarVerdict | null = null;
  const expected = loadedSong?.chordSequence[currentBarChordIdx] ?? "";
  // A bar whose chord we can't parse has nothing to grade against: the detector
  // held no target, so missing/extra are empty and the bar would score a
  // flawless HIT on silence. Skip it entirely rather than feed a fiction to the
  // trail, the hit rate and the coach.
  const gradeable = !!expected && chordPitchClasses(expected).length > 0;
  if (currentBar >= 0 && loadedSong && gradeable) {
    sealed = seal(barAccum, {
      bar: currentBar + 1, // 1-based for anything a human or the LLM reads
      chordIdx: currentBarChordIdx,
      expected,
      section: sectionOfIdx[currentBarChordIdx] ?? "",
      // Wait-mode holds the playhead until the chord is found, so the gap
      // between downbeat and strum is the mode working as intended, not the
      // player being late. Report no timing rather than a false accusation.
      barStartAt: currentBarWaited ? null : currentBarStartedAt,
      // Beat grid for rhythm scoring. Untimed songs pass 0 and get no rhythm
      // verdict, which is right: there is no grid to have played against.
      beats: timed ? beatsPerBar : 0,
      secPerBeat: timed ? secPerBeat : 0,
      camera: cameraStrokesForBar(currentBarStartedAt, at),
    });
    verdicts.push(sealed);
  }
  barAccum = newAccumulator();
  currentBar = nextBar;
  currentBarChordIdx = nextChordIdx;
  currentBarStartedAt = at;
  currentBarWaited = false;
  // After the state swap, and with the verdict passed explicitly: the triggers
  // must reason about the bar that was just graded, not whichever bar happens to
  // be open by the time they run.
  if (sealed) deps.onBarSealed(sealed);
}

// Untimed songs have no bar clock, so a "bar" is one chord: seal when the player
// advances. There is no downbeat to measure against, hence no timing claims.
export function sealUntimedChord(chordIdx: number) {
  if (timed) return;
  sealCurrentBar(chordIdx, chordIdx, null);
}

export function startTransport() {
  if (!timed) return;
  playing = true;
  waiting = false;
  lastTickAt = performance.now();
  deps.onPlayingChanged(true);
  deps.syncKeepAwake();
  if (hasBacking) playBacking();
}

export function stopTransport() {
  const wasPlaying = playing;
  playing = false;
  waiting = false;
  deps.onPlayingChanged(false);
  deps.syncKeepAwake();
  if (hasBacking) nativeInvoke("pause_backing").catch(() => {});
  // Stopping is when the player wants to know how that went. The buffer is left
  // intact so pressing play again continues the same run. Gated on wasPlaying
  // because setupTiming() calls this on every song load — coaching the player
  // about the song they just navigated away from would be nonsense.
  if (wasPlaying) deps.requestCoaching("paused");
}

export function restartTransport() {
  songTime = 0;
  songIdx = 0;
  waiting = false;
  // The engine is about to be re-armed at 0; an anchor from the old position
  // would extrapolate the playhead right back to where it was.
  backingAnchor = null;
  resetScoring(); // a fresh run from the top is a fresh score
  deps.onTimeChanged(0);
  deps.onChordIndexChanged();
  setTarget(loadedSong?.chordSequence[0] ?? "");
  if (hasBacking) {
    // reload from the top (rustysynth seeks via reload at pos 0)
    loadBackingIntoEngine();
    if (playing) playBacking();
  }
  deps.onPracticeStateChanged();
}

// Move songIdx to the chord whose beat window contains `beat`; updates target.
// Also the single place bars are closed out: both the wall-clock tick and the
// backing-audio sync funnel through here, so scoring can't miss a bar or
// double-count one depending on which clock is driving the playhead.
export function applyBeat(beat: number) {
  if (!loadedSong) return;
  let idx = songIdx;
  while (idx + 1 < chordBeat.length && chordBeat[idx + 1] <= beat) idx++;
  while (idx > 0 && chordBeat[idx] > beat) idx--;

  const bar = barOfBeat(beat, beatsPerBar);
  if (bar !== currentBar) {
    // We notice the boundary a frame or two after it passed. Back out that
    // overshoot so the timing offset measures the player against the downbeat,
    // not against when the render loop happened to look.
    const overshootMs = (beat - bar * beatsPerBar) * secPerBeat * 1000;
    sealCurrentBar(bar, idx, performance.now() - overshootMs);
  }

  if (idx !== songIdx) {
    songIdx = idx;
    deps.onChordIndexChanged();
    setTarget(loadedSong.chordSequence[idx]);
  }
}

// Whether the current chord has been played acceptably (used by wait-mode).
function currentChordSatisfied(): boolean {
  return isCleanHit(deps.currentReading());
}

// advance the playhead each render frame. With backing audio, the Rust
// position drives us (synced via the `backing` event), so the wall-clock
// fallback here only runs for MIDI songs without audio. Wait-mode pauses the
// transport at the next chord boundary until the player nails the chord.
export function tickTransport() {
  if (!playing || !timed || !loadedSong) return;

  // wait-mode gate: if we're holding for the player, resume once they play it
  if (waiting) {
    if (currentChordSatisfied()) {
      waiting = false;
      deps.onPracticeStateChanged(); // no longer refreshed every frame
      if (hasBacking) playBacking();
    } else {
      lastTickAt = performance.now();
      return; // stay parked on this chord
    }
  }

  if (hasBacking) {
    // The `backing` events anchor the playhead every ~50ms; dead-reckon from
    // the newest anchor so the highway advances every FRAME, not every event.
    // Without this the playhead stepped once per status event (~170ms with the
    // old emit throttle) and chords hit the NOW line visibly off the audio.
    if (backingAnchor?.playing) {
      const dt = Math.min(BACKING_COAST_MAX, (performance.now() - backingAnchor.at) / 1000);
      const t = backingAnchor.pos + dt;
      if (t > songTime) applyBackingTime(t);
    }
    return;
  }

  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTickAt) / 1000); // clamp big gaps
  lastTickAt = now;
  songTime += dt;
  const beat = songTime / secPerBeat;
  deps.onTimeChanged(songTime);
  maybeWaitAtBoundary(beat);
  if (!waiting) applyBeat(beat);
  // loop at the end
  if (beat >= songBeats) {
    // A full pass through the song is the natural moment for a review, and the
    // buffer is about to be rewound — so ask before clearing it.
    deps.requestCoaching("song end");
    songTime = 0;
    songIdx = 0;
    resetScoring();
    deps.onChordIndexChanged();
    setTarget(loadedSong.chordSequence[0]);
  }
}

// In wait-mode, if the playhead is about to cross into the next chord but the
// player hasn't satisfied the *current* one, park there (pause backing too).
function maybeWaitAtBoundary(beat: number) {
  if (!waitMode || !loadedSong) return;
  const next = songIdx + 1;
  if (next < chordBeat.length && beat >= chordBeat[next] && !currentChordSatisfied()) {
    waiting = true;
    currentBarWaited = true; // suppresses this bar's timing offset (see sealCurrentBar)
    // clamp the playhead just before the boundary so we don't advance
    songTime = chordBeat[next] * secPerBeat - 0.001;
    if (hasBacking) nativeInvoke("pause_backing").catch(() => {});
    deps.onPracticeStateChanged();
  }
}

// Called from the `backing` event: the Rust playback position is authoritative
// when audio is playing, so map it onto the highway playhead.
//
// `pos` counts samples RENDERED into the output buffer, which runs ahead of the
// speaker by `latency` (device buffer + route latency — tens of ms wired,
// hundreds on Bluetooth); subtract it so the NOW line tracks what the player
// HEARS. Events arrive every ~50ms of playback; this only (re-)anchors the
// dead-reckoning that tickTransport advances every frame.
export function syncBackingPos(pos: number, latency = 0, enginePlaying = true) {
  if (!timed || !loadedSong || !hasBacking) return;
  const heard = Math.max(0, pos - latency);
  backingAnchor = { pos: heard, at: performance.now(), playing: enginePlaying };
  if (!enginePlaying) return;
  // The backing engine owns looping, so a position that jumps backwards is the
  // song wrapping. Review the pass and start a fresh score, mirroring what the
  // wall-clock path does at `beat >= songBeats`.
  if (heard + 0.5 < songTime) {
    deps.requestCoaching("song end");
    resetScoring();
    songTime = heard;
  }
  // Between-event positions come from extrapolation; an anchor slightly behind
  // the extrapolated playhead is jitter, not information. Let applyBackingTime
  // hold until real time catches up rather than stepping the playhead backwards.
  applyBackingTime(Math.max(songTime, heard));
}

// Advance the playhead to `t` (seconds) and run the beat machinery. Shared by
// the event anchor and the per-frame extrapolation so bars can't be sealed
// differently depending on which one happened to notice the boundary.
function applyBackingTime(t: number) {
  songTime = t;
  const beat = t / secPerBeat;
  deps.onTimeChanged(t);
  maybeWaitAtBoundary(beat);
  if (!waiting) applyBeat(beat);
}

// Clicking a lyric cue jumps the target to that chord (same path as a strip
// chip): set songIdx, refresh both views, and tell the detector the new target.
export function jumpToChord(idx: number) {
  if (!loadedSong || idx < 0 || idx >= loadedSong.chordSequence.length) return;
  songIdx = idx;
  deps.onChordIndexChanged();
  setTarget(loadedSong.chordSequence[idx]);
}

// advance to the next chord when the current one is played cleanly. Only for
// UNTIMED songs — when a song is timed, the transport playhead owns the
// position and we don't want a good strum to skip ahead of the music.
export function maybeAdvance(reading: ChordReading) {
  if (!loadedSong || !targetChord || timed) return;
  const hit = isCleanHit(reading);
  if (hit) {
    advanceHold++;
    // require a few consecutive good frames (~0.25s) to avoid double-skips
    if (advanceHold >= 4 && songIdx < loadedSong.chordSequence.length - 1) {
      songIdx++;
      advanceHold = 0;
      sealUntimedChord(songIdx);
      deps.onChordIndexChanged();
      setTarget(loadedSong.chordSequence[songIdx]);
    }
  } else {
    advanceHold = 0;
  }
}

// --- read access for the views ---
// Getters rather than exported `let`s: a view that could assign these could
// desynchronise the playhead from the score, which is the one thing this
// module exists to prevent.

export function currentSong(): Song | null {
  return loadedSong;
}
export function currentRecord(): SongRecord | null {
  return loadedRecord;
}
export function currentChordIdx(): number {
  return songIdx;
}
export function currentTarget(): string {
  return targetChord;
}
/// False when neither side could parse the target, so `missing`/`extra` come
/// back empty — indistinguishable from a flawless chord. Everything that grades
/// must check this first.
export function isTargetGradeable(): boolean {
  return targetGradeable;
}
export function isTimed(): boolean {
  return timed;
}
export function isPlaying(): boolean {
  return playing;
}
export function isWaiting(): boolean {
  return waiting;
}
export function isWaitMode(): boolean {
  return waitMode;
}
export function currentSongTime(): number {
  return songTime;
}
export function beatOfChord(i: number): number {
  return chordBeat[i];
}
export function chordBeatCount(): number {
  return chordBeat.length;
}
export function totalBeats(): number {
  return songBeats;
}
export function secondsPerBeat(): number {
  return secPerBeat;
}
export function barBeats(): number {
  return beatsPerBar;
}
export function verdictBuffer(): VerdictBuffer {
  return verdicts;
}
export function hasBackingAudio(): boolean {
  return hasBacking;
}
export function backingTrackList(): BackingTrackInfo[] {
  return backingTracks;
}
export function selectedBackingChannels(): number[] {
  return selectedChannels;
}
export function sectionOfChord(i: number): string {
  return sectionOfIdx[i] ?? "";
}

/// Toggle wait-mode. Returns the new state so the button can follow.
export function toggleWaitMode(): boolean {
  waitMode = !waitMode;
  if (!waitMode && waiting) {
    waiting = false;
    if (playing && hasBacking) playBacking();
  }
  return waitMode;
}

/// Set which MIDI channels sound, then re-filter the loaded backing.
export function setBackingChannels(channels: number[]): void {
  selectedChannels = channels;
  applyChannelSelection();
}

/// Adopt a freshly loaded song. The caller has already built its views.
export function setLoadedSong(song: Song, rec: SongRecord): void {
  loadedSong = song;
  loadedRecord = rec;
  songIdx = 0;
  advanceHold = 0;
}

/// Fold one detector window into the bar being scored.
export function accumulateReading(reading: ChordReading, at: number): void {
  accumulate(barAccum, reading, at);
}
