// The Play screen: the per-frame render loop, the practice header both
// practice screens share, and the diagnostics drawer.
//
// renderChords is the only rAF loop on this side of the app. It reads the
// latest detector reading and the session's position once per frame and hands
// them to the renderers — highway, fretboards, gauge, FFT, chroma, breakdown —
// none of which know about each other.

import { chordPitchClasses } from "../../theory/chords.ts";
import { currentMode, isPracticeMode } from "../../state/appMode.ts";
import type { ChordReading } from "../../native.ts";
import {
  currentChordIdx,
  currentRecord,
  currentSong,
  currentTarget,
  hasBackingAudio,
  isPlaying,
  isCleanHit,
  isTargetGradeable,
  isTimed,
  isWaiting,
  nextDistinctChord,
  tickTransport,
  verdictBuffer,
} from "../../session.ts";
import { drawHighway } from "./highway.ts";
import { drawGauge, setGaugeReadout } from "./gauge.ts";
import { decaySpectrum, drawFFT, easeSpectrum, setFftGoldPitchClasses } from "./fft.ts";
import { drawChroma } from "./chroma.ts";
import { renderBreakdown } from "./breakdown.ts";
import { paintFretboards, updateFretboardPanelState } from "./fretboard.ts";

export interface PlayViewDeps {
  /// The latest detector reading, and when it arrived.
  currentReading: () => ChordReading | null;
  lastReadingAt: () => number;
  /// Is the chord detector running?
  isChordListening: () => boolean;
  /// Paint the shared "is the mic feeding us" indicator.
  setConn: (live: boolean) => void;
  /// Drop the held reading. With no frames for a while the last one is stale,
  /// and the hero chord would keep asserting a verdict about audio from
  /// minutes ago — visible as a lit "Locked in" on a fresh song with the mic
  /// idle.
  clearReading: () => void;
}

let deps: PlayViewDeps;

// eased cleanliness, so the gauge doesn't jitter frame to frame
let smoothClean = 0;
// When the last attack was seen, so the diagnostics lamp can stay lit long
// enough to perceive — an onset is true for one reading only.
let lastOnsetAt = 0;

/// Note that an attack was just detected, so the onset lamp can hold.
export function noteOnset(at: number): void {
  lastOnsetAt = at;
}

let playView: HTMLElement;
let chordNameEl: HTMLElement;
let chordSubEl: HTMLElement;
let cleanTargetEl: HTMLElement;
let coachEl: HTMLElement;
let mMatchEl: HTMLElement;
let mfMatchEl: HTMLElement;
let mFluxEl: HTMLElement;
let mOnsetEl: HTMLElement;
let diagBtn: HTMLElement;
let diagDrawer: HTMLElement;
let diagCloseBtn: HTMLElement;

let songTagEl: HTMLElement;
let modeTagEl: HTMLElement;
let practiceTitleEl: HTMLElement;
let practiceSubEl: HTMLElement;
let practicePosEl: HTMLElement;
let practiceNextEl: HTMLElement;

/// Say something in the coach line — the app's one place for a status message
/// the player is actually looking at.
export function setCoachMessage(text: string, className = "coach"): void {
  coachEl.className = className;
  coachEl.textContent = text;
}

// Diagnostics drawer: the analyzer instrumentation (gauge, chroma, FFT, peaks)
// is hidden by default and slides up on demand. The canvases keep their layout
// size while hidden (see .drawer[hidden] in CSS) so the draw loop is harmless.
export function toggleDiagnostics(force?: boolean) {
  const open = force ?? diagDrawer.hidden;
  diagDrawer.hidden = !open;
  diagBtn.classList.toggle("on", open);
}


export function updatePracticeUi() {
  const song = currentSong();
  // mode bar edge + tag: teal "free play" vs. gold "practice"
  playView.classList.toggle("free", !song);
  if (!song) {
    modeTagEl.textContent = "● Free play";
    songTagEl.textContent = "free detection";
    practiceTitleEl.textContent = "Free play";
    practiceSubEl.textContent = deps.isChordListening() ? "mic live" : "mic idle";
    practicePosEl.textContent = "--";
    practiceNextEl.textContent = "choose song";
    return;
  }
  modeTagEl.textContent = "● Practice";

  const title = currentRecord()?.title || song.title || "Untitled";
  const artist = currentRecord()?.artist || song.artist;
  const current = song.chordSequence[currentChordIdx()] ?? "--";
  const next = nextDistinctChord();
  const modeText = isTimed()
    ? `${Math.round(song.tempo)} bpm · ${isWaiting() ? "waiting" : isPlaying() ? "playing" : "paused"}`
    : "play-to-advance";
  const micText = deps.isChordListening() ? "mic live" : "mic idle";
  const backingText = hasBackingAudio() ? "backing" : "no backing";
  // Rolling score over the last 16 bars: enough history to mean something,
  // short enough that fixing a rough patch shows up while you're still on it.
  const score = verdictBuffer().hitCount(16);
  const scoreText = score.total ? ` · ${score.hits}/${score.total} bars` : "";
  // Rhythm alongside the chord score, because they fail independently: a player
  // can hold every chord perfectly and still strum once where the bar wants four.
  const rhythmText = isTimed() ? verdictBuffer().rhythmSummary(16) : "";

  songTagEl.textContent = artist ? `${title} · ${artist}` : title;
  practiceTitleEl.textContent = artist ? `${title} — ${artist}` : title;
  practiceSubEl.textContent =
    (isTimed() ? `${modeText} · ${micText} · ${backingText}` : `${modeText} · ${micText}`) +
    scoreText + rhythmText;
  practicePosEl.textContent = `${currentChordIdx() + 1}/${song.chordSequence.length} · ${current}`;
  practiceNextEl.textContent = next ? `next ${next}` : "last chord";
}

// map a note name like "G" / "F#" / "Bb" / "G3" to a pitch-class index 0..11

function renderChords() {
  // This loop only paints the Play view. On other views, skip all the canvas /
  // DOM work but keep the transport tick alive on the Arrangement view so a
  // timed song without backing audio (wall-clock playhead) still advances.
  if (!isPracticeMode(currentMode())) {
    requestAnimationFrame(renderChords);
    return;
  }
  if (currentMode() === "arrangement") {
    tickTransport();
    requestAnimationFrame(renderChords);
    return;
  }
  const now = performance.now();
  // Drop a reading the mic has stopped refreshing. NOT gated on deps.isChordListening():
  // when the stream stops, the last reading used to sit on screen indefinitely,
  // so the hero chord kept asserting a verdict about audio from minutes ago —
  // visible as a lit-up "Locked in" on a freshly loaded song with the mic idle.
  if (deps.currentReading() && now - deps.lastReadingAt() > 300) {
    deps.clearReading();
    if (deps.isChordListening() && now - deps.lastReadingAt() > 1500) deps.setConn(false);
  }

  const c = deps.currentReading();
  let fretboardMatched = false;
  const targetPcs = chordPitchClasses(currentTarget());
  // FFT gold highlight follows the target chord if set, else the detected one
  setFftGoldPitchClasses(
    currentTarget()
      ? targetPcs
      : c && c.active && c.detected
        ? chordPitchClasses(c.detected)
        : []
  );
  if (c && c.active) {
    const pct = Math.round(c.cleanliness * 100);
    const clean = c.cleanliness >= 0.85;
    // hero chord = what to play (target) when a song is loaded; the detected
    // chord otherwise. For target chords, use the same tolerant note-diff hit
    // rule as the coach and auto-advance so the screen gives one verdict.
    const matched = currentTarget() ? isCleanHit(c) : !!c.detected;
    fretboardMatched = matched;
    const hero = currentTarget() || c.detected || "—";
    chordNameEl.textContent = hero;
    chordNameEl.className = "chord-name " + (matched ? "clean" : "dirty");
    // A target we can't parse gets no verdict at all — say so plainly instead of
    // reporting on a comparison that never happened.
    chordSubEl.textContent = !currentTarget()
      ? "Playing"
      : !isTargetGradeable()
        ? `can't grade ${currentTarget()} — heard ${c.detected || "—"}`
        : matched
          ? "Locked in"
          : `heard ${c.detected || "—"}`;
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    setGaugeReadout(`${pct}<span class="pct">%</span>`, clean ? "clean" : pct >= 70 ? "almost" : "off");
    cleanTargetEl.textContent = currentTarget() ? `target · ${currentTarget()}` : "free play";

    // coach text from missing/extra
    if (!currentTarget()) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">free play</span> · heard <b>${c.detected || "—"}</b>`;
    } else if (!isTargetGradeable()) {
      coachEl.className = "coach";
      coachEl.innerHTML = `<span class="miss">can't grade <b>${currentTarget()}</b></span> — not a chord we know, so this bar isn't scored`;
    } else if (isCleanHit(c)) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">nice — that's a clean ${currentTarget()} ✓</span>`;
    } else {
      coachEl.className = "coach";
      const parts: string[] = [];
      if (c.missing.length)
        parts.push(`<span class="miss">missing <b>${c.missing.join(", ")}</b></span> — check that string is ringing`);
      if (c.extra.length)
        parts.push(`<span class="miss">extra <b>${c.extra.join(", ")}</b></span> — try muting`);
      coachEl.innerHTML = parts.join("<br>");
    }
    renderBreakdown(c);

    // chromagram (height-driven vertical bars)
    drawChroma(c.chroma, targetPcs);

    // spectrum: ease smoothed buffer toward incoming 96 real bins
    easeSpectrum(c.spectrum ?? []);

    // analyzer: match% follows cleanliness vs the target (or detection conf)
    mMatchEl.textContent = `${pct}%`;
    mfMatchEl.style.width = `${pct}%`;
    mfMatchEl.classList.toggle("gold", !matched);
    // onset detector: flux ratio plus a lamp held on for 140ms, since `onset` is
    // true for a single reading and would otherwise be invisible.
    mFluxEl.textContent = `${c.flux.toFixed(1)}x`;
    mOnsetEl.classList.toggle("lit", now - lastOnsetAt < 140);

    paintFretboards(c.detected, matched);
  } else {
    chordNameEl.textContent = currentTarget() || "—";
    chordNameEl.className = "chord-name";
    chordSubEl.textContent = currentTarget() ? "Play this" : "Playing";
    smoothClean += (0 - smoothClean) * 0.15;
    setGaugeReadout(`0<span class="pct">%</span>`, deps.isChordListening() ? "listening…" : "idle");
    cleanTargetEl.textContent = currentTarget() ? `target · ${currentTarget()}` : "free play";
    coachEl.className = "coach good";
    coachEl.textContent = deps.isChordListening() ? "play a chord" : "press start to listen";
    renderBreakdown(null);
    mMatchEl.textContent = "—";
    mfMatchEl.style.width = "0%";
    mFluxEl.textContent = "—";
    mOnsetEl.classList.remove("lit");
    drawChroma(null, targetPcs);
    // flat FFT when idle
    decaySpectrum();
    paintFretboards("", false);
  }

  tickTransport();
  updateFretboardPanelState(fretboardMatched);
  drawHighway();
  drawGauge(smoothClean, c?.active ?? false);
  drawFFT();
  requestAnimationFrame(renderChords);
}

export function initPlayView(d: PlayViewDeps): void {
  deps = d;
  playView = document.getElementById("play-view")!;
  chordNameEl = document.getElementById("chord-name")!;
  chordSubEl = document.getElementById("chord-sub")!;
  cleanTargetEl = document.getElementById("clean-target")!;
  coachEl = document.getElementById("coach")!;
  mMatchEl = document.getElementById("m-match")!;
  mfMatchEl = document.getElementById("mf-match") as HTMLElement;
  mFluxEl = document.getElementById("m-flux")!;
  mOnsetEl = document.getElementById("m-onset")!;
  diagBtn = document.getElementById("diag-btn")!;
  diagDrawer = document.getElementById("diag-drawer")!;
  diagCloseBtn = document.getElementById("diag-close")!;
  songTagEl = document.getElementById("song-tag")!;
  modeTagEl = document.getElementById("mode-tag")!;
  practiceTitleEl = document.getElementById("practice-title")!;
  practiceSubEl = document.getElementById("practice-sub")!;
  practicePosEl = document.getElementById("practice-pos")!;
  practiceNextEl = document.getElementById("practice-next")!;

  diagBtn.addEventListener("click", () => toggleDiagnostics());
  diagCloseBtn.addEventListener("click", () => toggleDiagnostics(false));

  requestAnimationFrame(renderChords);
}

