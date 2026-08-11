import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { addSong, listSongs, deleteSong, getSong, renameSong, libraryReady, LibraryFullError, type SongRecord } from "./library";
import type { Song, SongLine } from "./song";
import {
  parseMidi,
  midiToChordChart,
  parseChordChart,
  buildFusedChordPro,
  titleFromFilename,
  suggestChordChannels,
  channelChordScores,
  type MidiData,
} from "./midi";

const nativeRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function nativeInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!nativeRuntime) return Promise.reject("native runtime unavailable");
  return tauriInvoke<T>(command, args);
}

function nativeListen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  if (!nativeRuntime) return Promise.resolve(() => {});
  return tauriListen<T>(event, handler as any).catch((e) => {
    console.warn(`native event '${event}' unavailable`, e);
    return () => {};
  });
}

interface TunerReading {
  active: boolean;
  freq: number;
  nearest: string;
  cents: number;
  rms: number;
}

interface ChordReading {
  active: boolean;
  detected: string;
  cleanliness: number;
  chroma: number[];
  spectrum: number[];
  missing: string[];
  extra: string[];
  rms: number;
}

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
type AppMode = "tuner" | "play" | "arrangement" | "cal-mic" | "library";

// Baritone open strings, low -> high.
const STRINGS = [
  { note: "D3", hz: 146.83 },
  { note: "G3", hz: 196.0 },
  { note: "B3", hz: 246.94 },
  { note: "E4", hz: 329.63 },
];

const IN_TUNE_CENTS = 5; // within +/- this many cents counts as in tune

// --- element refs ---
const noteNameEl = document.getElementById("note-name")!;
const noteFreqEl = document.getElementById("note-freq")!;
const centsValEl = document.getElementById("cents-val")!;
const verdictEl = document.getElementById("verdict")!;
const listenBtn = document.getElementById("listen-btn") as HTMLButtonElement;
const connEl = document.querySelector(".conn") as HTMLElement;
const connText = document.getElementById("conn-text")!;
const stringsEl = document.getElementById("strings")!;
const needle = document.getElementById("needle") as HTMLCanvasElement;
const nctx = needle.getContext("2d")!;

let listening = false;
let lastFrameAt = 0;
let smoothCents = 0; // eased needle position
let current: TunerReading | null = null;

// mic-calibration state (used by both audio listeners and the Setup screen)
let calibrating = false;
let calibSamples: number[] = [];
function noteRms(rms: number) {
  if (calibrating) calibSamples.push(rms);
}

// --- build per-string rows ---
const stringRows = new Map<string, HTMLElement>();
for (const s of STRINGS) {
  const row = document.createElement("div");
  row.className = "string-row";
  row.innerHTML = `
    <span class="string-note">${s.note[0]}</span>
    <span class="string-meta">${s.note} · ${s.hz.toFixed(1)} Hz</span>
    <span class="string-check">○</span>`;
  stringsEl.appendChild(row);
  stringRows.set(s.note, row);
}

// --- listen toggle ---
listenBtn.addEventListener("click", async () => {
  if (!listening) {
    try {
      await nativeInvoke("start_tuner");
      listening = true;
      listenBtn.textContent = "Stop listening";
      listenBtn.classList.add("on");
      setConn(false);
    } catch (e) {
      verdictEl.textContent = `mic error: ${e}`;
    }
  } else {
    await nativeInvoke("stop_tuner");
    listening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    setConn(false);
  }
});

// --- receive readings from Rust ---
nativeListen<TunerReading>("tuner", (event) => {
  current = event.payload;
  lastFrameAt = performance.now();
  setConn(true);
  noteRms(event.payload.rms);
});

function setConn(live: boolean) {
  connEl.classList.toggle("live", live);
  connText.textContent = live ? "live" : listening ? "listening…" : "idle";
}

// --- render loop ---
function render() {
  // Only the tuner view needs this loop; idle otherwise (keep self-rescheduling
  // so returning to the tuner resumes instantly).
  if (mode !== "tuner") {
    requestAnimationFrame(render);
    return;
  }
  const now = performance.now();
  // If no frame for >300ms while listening, treat as silence/idle.
  if (listening && now - lastFrameAt > 300) {
    current = { active: false, freq: 0, nearest: "", cents: 0, rms: 0 };
    if (now - lastFrameAt > 1500) setConn(false);
  }

  const r = current;
  if (r && r.active) {
    const cls =
      Math.abs(r.cents) <= IN_TUNE_CENTS ? "in-tune" : r.cents < 0 ? "flat" : "sharp";

    noteNameEl.textContent = r.nearest.replace(/[0-9]/g, "");
    noteNameEl.className = "note-name " + cls;
    noteFreqEl.textContent = `${r.freq.toFixed(1)} Hz`;
    centsValEl.textContent = (r.cents > 0 ? "+" : "") + r.cents.toFixed(0);

    verdictEl.className = "verdict " + cls;
    verdictEl.textContent =
      cls === "in-tune" ? "in tune ✓" : cls === "flat" ? "tune up ↑" : "tune down ↓";

    for (const [note, row] of stringRows) {
      row.classList.toggle("active", note === r.nearest);
      const tuned = note === r.nearest && cls === "in-tune";
      row.classList.toggle("tuned", tuned);
      row.querySelector(".string-check")!.textContent = tuned ? "✓" : "○";
    }

    smoothCents += (clamp(r.cents, -50, 50) - smoothCents) * 0.25;
  } else {
    noteNameEl.textContent = "—";
    noteNameEl.className = "note-name";
    noteFreqEl.textContent = "0.0 Hz";
    centsValEl.textContent = "0";
    verdictEl.className = "verdict";
    verdictEl.textContent = listening ? "play a string" : "press start";
    for (const row of stringRows.values()) {
      row.classList.remove("active", "tuned");
      row.querySelector(".string-check")!.textContent = "○";
    }
    smoothCents += (0 - smoothCents) * 0.15;
  }

  drawNeedle(smoothCents, r?.active ?? false);
  requestAnimationFrame(render);
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

// --- needle canvas (drawn in CSS pixels via DPR transform) ---
function drawNeedle(cents: number, active: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w = needle.width / dpr;
  const h = needle.height / dpr;
  nctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  nctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const span = w / 2 - 40; // px from center to +/-50 cents
  const top = 14;
  const baseY = h - 20;

  // tick marks
  nctx.strokeStyle = "#16242a";
  nctx.lineWidth = 1;
  for (let c = -50; c <= 50; c += 10) {
    const x = cx + (c / 50) * span;
    nctx.globalAlpha = c % 50 === 0 ? 0.9 : 0.5;
    nctx.beginPath();
    nctx.moveTo(x, top + 8);
    nctx.lineTo(x, baseY);
    nctx.stroke();
  }
  nctx.globalAlpha = 1;

  // center in-tune zone glow
  const zoneW = (IN_TUNE_CENTS / 50) * span;
  const grad = nctx.createLinearGradient(cx - zoneW, 0, cx + zoneW, 0);
  grad.addColorStop(0, "rgba(25,227,196,0)");
  grad.addColorStop(0.5, "rgba(25,227,196,0.20)");
  grad.addColorStop(1, "rgba(25,227,196,0)");
  nctx.fillStyle = grad;
  nctx.fillRect(cx - zoneW, top + 8, zoneW * 2, baseY - top - 8);

  // moving indicator
  const x = cx + (cents / 50) * span;
  const inTune = Math.abs(cents) <= IN_TUNE_CENTS && active;
  const color = !active ? "#3a5450" : inTune ? "#19e3c4" : "#f5c451";

  nctx.shadowColor = color;
  nctx.shadowBlur = active ? 24 : 0;
  nctx.strokeStyle = color;
  nctx.lineWidth = 3;
  nctx.beginPath();
  nctx.moveTo(x, top + 6);
  nctx.lineTo(x, baseY);
  nctx.stroke();

  // pointer triangle
  nctx.fillStyle = color;
  nctx.beginPath();
  nctx.moveTo(x, top + 6);
  nctx.lineTo(x - 9, top - 6);
  nctx.lineTo(x + 9, top - 6);
  nctx.closePath();
  nctx.fill();
  nctx.shadowBlur = 0;
}

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = needle.getBoundingClientRect();
  needle.width = rect.width * dpr;
  needle.height = 170 * dpr;
}

window.addEventListener("resize", sizeCanvas);
sizeCanvas();
requestAnimationFrame(render);

// =====================================================================
// Play mode — live chord detection
// =====================================================================
const tunerView = document.getElementById("tuner-view")!;
const playView = document.getElementById("play-view")!;
const arrangementView = document.getElementById("arrangement-view")!;
const setupView = document.getElementById("setup-view")!;
const libraryView = document.getElementById("library-view")!;
const cornerLabel = document.getElementById("corner-label")!;
// any element with data-mode navigates (util buttons + back buttons)
const modeBtns = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

const chordNameEl = document.getElementById("chord-name")!;
const chordSubEl = document.getElementById("chord-sub")!;
const highway = document.getElementById("highway") as HTMLCanvasElement;
const hctx = highway.getContext("2d")!;
const transportEl = document.getElementById("transport")!;
const tpPlayBtn = document.getElementById("tp-play") as HTMLButtonElement;
const tpRestartBtn = document.getElementById("tp-restart") as HTMLButtonElement;
const tpTimeEl = document.getElementById("tp-time")!;
const tpBpmEl = document.getElementById("tp-bpm")!;
const backingControlsEl = document.getElementById("backing-controls")!;
const tpTracksBtn = document.getElementById("tp-tracks") as HTMLButtonElement;
const tpWaitBtn = document.getElementById("tp-wait") as HTMLButtonElement;
const trackPickerEl = document.getElementById("track-picker")!;
const sfOverlayEl = document.getElementById("sf-overlay")!;
const sfCloseBtn = document.getElementById("sf-close") as HTMLButtonElement;
const sfDownloadBtn = document.getElementById("sf-download") as HTMLButtonElement;
const sfProgressEl = document.getElementById("sf-progress") as HTMLProgressElement;
const sfStatusEl = document.getElementById("sf-status")!;
const sfPathEl = document.getElementById("sf-path")!;
const sfOpenFolderBtn = document.getElementById("sf-open-folder") as HTMLButtonElement;
const arrTransportEl = document.getElementById("arr-transport")!;
const arrPlayBtn = document.getElementById("arr-play") as HTMLButtonElement;
const arrRestartBtn = document.getElementById("arr-restart") as HTMLButtonElement;
const arrTimeEl = document.getElementById("arr-time")!;
const arrBpmEl = document.getElementById("arr-bpm")!;
const cleanValEl = document.getElementById("clean-val")!;
const cleanStatusEl = document.getElementById("clean-status")!;
const cleanTargetEl = document.getElementById("clean-target")!;
const coachEl = document.getElementById("coach")!;
const targetNotesEl = document.getElementById("target-notes")!;
const listenBtn2 = document.getElementById("listen-btn-2") as HTMLButtonElement;
const gauge = document.getElementById("gauge") as HTMLCanvasElement;
const gctx = gauge.getContext("2d")!;
const chromaEl = document.getElementById("chroma")!;
const fft = document.getElementById("fft") as HTMLCanvasElement;
const fctx = fft.getContext("2d")!;
const currentFretboardEl = document.getElementById("current-fretboard")!;
const currentFingerTagEl = document.getElementById("current-finger-tag")!;
const currentFingerTitleEl = document.getElementById("current-finger-title")!;
const currentFingerPanelEl = document.querySelector<HTMLElement>(".current-finger-panel")!;
const currentShapeControlsEl = document.getElementById("current-shape-controls")!;
const currentShapePrevBtn = document.getElementById("current-shape-prev") as HTMLButtonElement;
const currentShapeNextBtn = document.getElementById("current-shape-next") as HTMLButtonElement;
const currentShapeCountEl = document.getElementById("current-shape-count")!;
const fretboardEl = document.getElementById("fretboard")!;
const fingerTagEl = document.getElementById("finger-tag")!;
const fingerTitleEl = document.getElementById("finger-title")!;
const nextFingerPanelEl = document.querySelector<HTMLElement>(".next-finger-panel")!;
const nextShapeControlsEl = document.getElementById("next-shape-controls")!;
const nextShapePrevBtn = document.getElementById("next-shape-prev") as HTMLButtonElement;
const nextShapeNextBtn = document.getElementById("next-shape-next") as HTMLButtonElement;
const nextShapeCountEl = document.getElementById("next-shape-count")!;
const transitionTagEl = document.getElementById("transition-tag")!;
const transitionCoachEl = document.getElementById("transition-coach")!;
// analyzer panel (right column)
const mMatchEl = document.getElementById("m-match")!;
const mfMatchEl = document.getElementById("mf-match") as HTMLElement;
const mPeakCountEl = document.getElementById("m-peakcount")!;
const peaksListEl = document.getElementById("peaks-list")!;
const arrangementTagEl = document.getElementById("arrangement-tag")!;
const arrangementNowEl = document.getElementById("arr-now")!;
const arrangementNextEl = document.getElementById("arr-next")!;
const arrangementCountEl = document.getElementById("arr-count")!;
const arrangementEmptyEl = document.getElementById("arrangement-empty")!;
const arrangementSheetEl = document.getElementById("arrangement-sheet")!;
const arrangementChordsEl = document.getElementById("arrangement-chords")!;
const arrangementChordTagEl = document.getElementById("arrangement-chord-tag")!;

type Voicing = (number | null)[];

// Verified baritone (D-G-B-E) voicings: fret per string [D, G, B, E];
// null = string not played. Every shape is checked to produce the correct
// chord tones (see the generator in the prototype). Covers all 12 majors,
// minors, plus common 7ths/maj7s/m7s.
const VOICINGS: Record<string, Voicing> = {
  C: [2, 0, 1, 0],
  "C#": [null, 1, 2, 1],
  D: [0, 2, 3, 2],
  "D#": [1, 3, 4, 3],
  E: [2, 1, 0, 0],
  F: [3, 2, 1, 1],
  "F#": [4, 3, 2, 2],
  G: [0, 0, 0, 3],
  "G#": [1, 1, 1, 4],
  A: [2, 2, 2, 0],
  "A#": [3, 3, 3, 1],
  B: [4, 4, 4, 2],
  Cm: [1, 0, 1, null],
  "C#m": [null, 1, 2, 0],
  Dm: [0, 2, 3, 1],
  "D#m": [1, 3, 4, 2],
  Em: [2, 0, 0, 0],
  Fm: [3, 1, 1, 1],
  "F#m": [4, 2, 2, 2],
  Gm: [0, 3, null, 3],
  "G#m": [1, 1, 0, null],
  Am: [2, 2, 1, 0],
  "A#m": [3, 3, 2, 1],
  Bm: [4, 4, 3, 2],
  C7: [2, 3, 1, 3],
  D7: [0, 2, 1, 2],
  E7: [0, 1, 0, 0],
  G7: [0, 0, 0, 1],
  A7: [2, 2, 2, 3],
  B7: [1, 2, 0, 2],
  Dm7: [0, 2, 1, 1],
  Em7: [0, 0, 0, 0],
  Am7: [2, 2, 1, 3],
  Cmaj7: [5, 5, 0, 0],
  Dmaj7: [0, 2, 2, 2],
  Fmaj7: [3, 2, 1, 0],
  Gmaj7: [0, 0, 0, 2],
  // exotic qualities found in real tabs (e.g. F#m7-5 in Foo Fighters "The
  // Pretender"). All shapes verified to produce the correct chord tones.
  Cm7b5: [1, 3, 1, 2], Cdim: [1, null, 1, 2], Cdim7: [1, 2, 1, 2], Caug: [null, 1, 1, 0],
  Csus2: [0, 0, 1, null], Csus4: [null, 0, 1, 1], C6: [5, 5, 5, 5], Cm6: [5, 5, 4, 5],
  Cadd9: [0, 0, 1, 0], C7sus4: [5, 5, 6, 6],
  "C#m7b5": [5, 6, 0, 0], "C#dim": [2, 0, 2, 0], "C#dim7": [2, 3, 2, 3], "C#aug": [null, 2, 2, 1],
  "C#sus2": [1, 1, 2, null], "C#sus4": [null, 1, 2, 2], "C#6": [6, 6, 6, 6], "C#m6": [6, 6, 5, 6],
  "C#add9": [1, 1, 2, 1], "C#7sus4": [6, 6, 7, 7],
  Dm7b5: [0, 1, 1, 1], Ddim: [0, 1, null, 1], Ddim7: [0, 1, 0, 1], Daug: [0, 3, 3, 2],
  Dsus2: [0, 2, null, 0], Dsus4: [0, 0, null, 5], D6: [0, 2, 0, 2], Dm6: [0, 2, 0, 1],
  Dadd9: [7, 7, 7, 0], D7sus4: [0, 2, 1, 3],
  "D#m7b5": [1, 2, 2, 2], "D#dim": [1, 2, null, 2], "D#dim7": [1, 2, 1, 2], "D#aug": [1, 0, 0, null],
  "D#sus2": [3, 3, 4, null], "D#sus4": [null, 3, 4, 4], "D#6": [1, 3, 1, 3], "D#m6": [1, 3, 1, 2],
  "D#add9": [3, 3, 4, 3], "D#7sus4": [6, 6, 4, 6],
  Em7b5: [0, 0, 5, 6], Edim: [5, 0, 5, 6], Edim7: [2, 3, 2, 3], Eaug: [null, 1, 1, 0],
  Esus2: [4, 4, 0, 0], Esus4: [2, 2, 0, 0], E6: [6, 6, 0, 0], Em6: [5, 6, 0, 0],
  Eadd9: [2, 1, 0, 2], E7sus4: [0, 2, 0, 0],
  Fm7b5: [1, 1, 0, 1], Fdim: [null, 1, 0, 1], Fdim7: [0, 1, 0, 1], Faug: [null, 2, 2, 1],
  Fsus2: [null, 0, 1, 1], Fsus4: [null, 5, 6, 6], F6: [0, 2, 1, 1], Fm6: [0, 1, 1, 1],
  Fadd9: [5, 5, 6, 5], F7sus4: [1, 3, 1, 1],
  "F#m7b5": [2, 2, 1, 2], "F#dim": [null, 2, 1, 2], "F#dim7": [1, 2, 1, 2], "F#aug": [0, 3, 3, 2],
  "F#sus2": [null, 1, 2, 2], "F#sus4": [null, 6, 7, 7], "F#6": [1, 3, 2, 2], "F#m6": [1, 2, 2, 2],
  "F#add9": [6, 6, 7, 6], "F#7sus4": [2, 4, 2, 2],
  Gm7b5: [3, 3, 2, 3], Gdim: [null, 3, 2, 3], Gdim7: [2, 3, 2, 3], Gaug: [1, 0, 0, null],
  Gsus2: [0, 0, null, 5], Gsus4: [0, 0, 1, null], G6: [0, 0, 0, 0], Gm6: [0, 0, 5, 6],
  Gadd9: [0, 0, 0, 5], G7sus4: [0, 0, 1, 1],
  "G#m7b5": [0, 1, 0, 2], "G#dim": [0, 4, 0, 4], "G#dim7": [0, 1, 0, 1], "G#aug": [null, 1, 1, 0],
  "G#sus2": [null, 3, 4, 4], "G#sus4": [1, 1, 2, null], "G#6": [1, 1, 1, 1], "G#m6": [1, 1, 0, 1],
  "G#add9": [6, 5, 4, 6], "G#7sus4": [1, 1, 2, 2],
  Am7b5: [5, 5, 4, 5], Adim: [1, 2, 1, null], Adim7: [1, 2, 1, 2], Aaug: [null, 2, 2, 1],
  Asus2: [2, 2, 0, 0], Asus4: [0, 2, null, 0], A6: [2, 2, 2, 2], Am6: [2, 2, 1, 2],
  Aadd9: [7, 6, 0, 0], A7sus4: [0, 0, 5, 5],
  "A#m7b5": [6, 6, 5, 6], "A#dim": [2, 3, 2, 0], "A#dim7": [2, 3, 2, 3], "A#aug": [0, 3, 3, 2],
  "A#sus2": [null, 5, 6, 6], "A#sus4": [3, 3, 4, null], "A#6": [0, 0, 6, 6], "A#m6": [3, 3, 2, 3],
  "A#add9": [0, 5, 6, 6], "A#7sus4": [3, 3, 4, 4],
  Bm7b5: [0, 2, 0, 1], Bdim: [0, null, 0, 1], Bdim7: [0, 1, 0, 1], Baug: [1, 0, 0, null],
  Bsus2: [null, 6, 7, 7], Bsus4: [4, 4, 0, 0], B6: [4, 4, 4, 4], Bm6: [0, 1, 0, 2],
  Badd9: [1, 4, 2, 2], B7sus4: [2, 2, 0, 2],
};
const STRING_LABELS = ["D", "G", "B", "E"];

let mode: AppMode = "play";
let chordListening = false;
let chord: ChordReading | null = null;
let lastChordAt = 0;
let smoothClean = 0;
let targetChord = "";

// FFT spectrum config + smoothed buffer. Must match the Rust log_spectrum:
// 96 bins log-spaced over 70..2000 Hz.
const FFT_BINS = 96;
const F_MIN = 70;
const F_MAX = 2000;
const smoothSpec = new Float32Array(FFT_BINS); // eased toward incoming spectrum
const logF = (f: number) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN); // 0..1 across axis
// center frequency of each log-spaced bin (matches Rust binning)
const binF = Array.from({ length: FFT_BINS }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, (i + 0.5) / FFT_BINS)
);
// pitch classes the current chord "owns" — bins matching these glow gold
let fftGoldPCs: number[] = [];

// build chromagram bars (vertical bars; `.fill` height is driven from chroma values)
const chromaFills: HTMLElement[] = [];
const chromaBars: HTMLElement[] = [];
for (let i = 0; i < 12; i++) {
  const bar = document.createElement("div");
  bar.className = "chroma-bar";
  bar.innerHTML = `<div class="track"><div class="fill"></div></div><span class="pc">${PITCH_CLASSES[i]}</span>`;
  chromaEl.appendChild(bar);
  chromaBars.push(bar);
  chromaFills.push(bar.querySelector(".fill")!);
}

// view navigation (Play is home; Tune + Setup are utility screens)
modeBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const m = btn.dataset.mode as AppMode | undefined;
    if (m !== "tuner" && m !== "play" && m !== "arrangement" && m !== "cal-mic" && m !== "library") return;
    if (m === mode) return;
    const fromPractice = mode === "play" || mode === "arrangement";
    const toPractice = m === "play" || m === "arrangement";
    // Chart and Play are both practice surfaces, so transport/backing/listening
    // state can continue while moving between them.
    if (!(fromPractice && toPractice)) {
      await nativeInvoke("stop_audio").catch(() => {});
      listening = false;
      chordListening = false;
      listenBtn.textContent = "Start listening";
      listenBtn.classList.remove("on");
      listenBtn2.textContent = "Start listening";
      listenBtn2.classList.remove("on");
      setConn(false);
    }
    if (fromPractice && !toPractice) {
      stopTransport();
      nativeInvoke("stop_backing").catch(() => {});
    }

    mode = m;
    tunerView.hidden = m !== "tuner";
    playView.hidden = m !== "play";
    arrangementView.hidden = m !== "arrangement";
    setupView.hidden = m !== "cal-mic";
    libraryView.hidden = m !== "library";
    // highlight the active utility button (Play has no util button → none lit)
    modeBtns.forEach((b) => b.classList.toggle("active", !!b.dataset.mode && b.dataset.mode === m));
    if (m === "library") renderSongList();
    if (m === "arrangement") updateArrangementState(true);
    cornerLabel.textContent =
      m === "tuner" ? "ukejam / Tuner · native"
      : m === "arrangement" ? "ukejam / Arrangement · native"
      : m === "cal-mic" ? "ukejam / Setup · native"
      : m === "library" ? "ukejam / Library · native"
      : "ukejam / Chords · native";
  });
});

listenBtn2.addEventListener("click", async () => {
  if (!chordListening) {
    try {
      await nativeInvoke("start_chords");
      await nativeInvoke("set_target", { chord: targetChord || null });
      chordListening = true;
      listenBtn2.textContent = "Stop listening";
      listenBtn2.classList.add("on");
      setConn(false);
    } catch (e) {
      coachEl.textContent = `mic error: ${e}`;
    }
  } else {
    await nativeInvoke("stop_audio");
    chordListening = false;
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);
  }
  updatePracticeUi(); // mic live/idle text is no longer refreshed every frame
});

// Diagnostics drawer: the analyzer instrumentation (gauge, chroma, FFT, peaks)
// is hidden by default and slides up on demand. The canvases keep their layout
// size while hidden (see .drawer[hidden] in CSS) so the draw loop is harmless.
const diagBtn = document.getElementById("diag-btn")!;
const diagDrawer = document.getElementById("diag-drawer")!;
const diagCloseBtn = document.getElementById("diag-close")!;
function toggleDiagnostics(force?: boolean) {
  const open = force ?? diagDrawer.hidden;
  diagDrawer.hidden = !open;
  diagBtn.classList.toggle("on", open);
}
diagBtn.addEventListener("click", () => toggleDiagnostics());
diagCloseBtn.addEventListener("click", () => toggleDiagnostics(false));

// Hands-free practice controls (the instrument is in your hands): space toggles
// play/pause, ←/→ step the current chord, d toggles the diagnostics drawer.
// Only active on the Play screen and never when typing in a field.
addEventListener("keydown", (e) => {
  if (mode !== "play") return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (timed) (playing ? stopTransport() : startTransport());
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    jumpToChord(songIdx + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    jumpToChord(songIdx - 1);
  } else if (e.key === "d" || e.key === "D") {
    toggleDiagnostics();
  }
});

// =====================================================================
// Library + loaded song (chord strip in Play, auto-advance)
// =====================================================================
const pasteBox = document.getElementById("paste-box") as HTMLTextAreaElement;
const songTitleInput = document.getElementById("song-title") as HTMLInputElement;
const songArtistInput = document.getElementById("song-artist") as HTMLInputElement;
const addSongBtn = document.getElementById("add-song-btn") as HTMLButtonElement;
const loadMidiBtn = document.getElementById("load-midi-btn") as HTMLButtonElement;
const midiInput = document.getElementById("midi-input") as HTMLInputElement;
const chanPickerEl = document.getElementById("chan-picker")!;
const chanChipsEl = document.getElementById("chan-chips")!;
const lyricsBox = document.getElementById("lyrics-box") as HTMLTextAreaElement;
const aiEnhanceToggle = document.getElementById("ai-enhance") as HTMLInputElement;
const libAddStatus = document.getElementById("lib-add-status")!;
const songListEl = document.getElementById("song-list")!;
const libCountEl = document.getElementById("lib-count")!;
const songBarEmpty = document.getElementById("song-bar-empty")!;
const songStrip = document.getElementById("song-strip")!;
const lyricsView = document.getElementById("lyrics-view")!;
const songTagEl = document.getElementById("song-tag")!;
const modeTagEl = document.getElementById("mode-tag")!;
const practiceTitleEl = document.getElementById("practice-title")!;
const practiceSubEl = document.getElementById("practice-sub")!;
const practicePosEl = document.getElementById("practice-pos")!;
const practiceNextEl = document.getElementById("practice-next")!;

// loaded song state
let loadedSong: Song | null = null;
let loadedRecord: SongRecord | null = null;
let songIdx = 0; // index into chordSequence = current target chord
let stripChordEls: HTMLElement[] = [];
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
const LOOKAHEAD_BEATS = 6; // how many beats ahead the highway shows

// backing-track (MIDI audio) state. When a song has backing audio, the Rust
// playback position drives the highway playhead (no drift); otherwise the
// wall clock does. selectedChannels = which MIDI channels sound (bass+drums
// by default — the player covers the rest).
let hasBacking = false;
let backingTracks: import("./library").BackingTrackInfo[] = [];
let selectedChannels: number[] = [];
let currentMidiB64: string | null = null;
// per-global-chord-index lyric token elements + the line each belongs to.
// Built in loadSongIntoPlay so songIdx -> {token, line} is O(1).
let lyricTokenEls: (HTMLElement | null)[] = [];
let lyricLineOfIdx: HTMLElement[] = [];
let arrangementChordEls: HTMLElement[] = [];
let arrangementLineOfIdx: HTMLElement[] = [];
let arrangementChordCards = new Map<string, HTMLElement>();
let lastArrangementScrollIdx = -1;

function setTarget(chord: string) {
  targetChord = chord;
  nativeInvoke("set_target", { chord: chord || null }).catch(() => {});
  updatePracticeUi();
}

function isCleanHit(reading: ChordReading | null): boolean {
  return !!reading?.active && reading.missing.length === 0 && reading.extra.length <= 1;
}

type NextChordInfo = {
  name: string;
  index: number;
  beatsUntil: number;
  urgency: number;
};

function nextDistinctChordInfo(): NextChordInfo {
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

function nextDistinctChord(): string {
  return nextDistinctChordInfo().name;
}

function updatePracticeUi() {
  // mode bar edge + tag: teal "free play" vs. gold "practice"
  playView.classList.toggle("free", !loadedSong);
  if (!loadedSong) {
    modeTagEl.textContent = "● Free play";
    songTagEl.textContent = "free detection";
    practiceTitleEl.textContent = "Free play";
    practiceSubEl.textContent = chordListening ? "mic live" : "mic idle";
    practicePosEl.textContent = "--";
    practiceNextEl.textContent = "choose song";
    return;
  }
  modeTagEl.textContent = "● Practice";

  const title = loadedRecord?.title || loadedSong.title || "Untitled";
  const artist = loadedRecord?.artist || loadedSong.artist;
  const current = loadedSong.chordSequence[songIdx] ?? "--";
  const next = nextDistinctChord();
  const modeText = timed
    ? `${Math.round(loadedSong.tempo)} bpm · ${waiting ? "waiting" : playing ? "playing" : "paused"}`
    : "play-to-advance";
  const micText = chordListening ? "mic live" : "mic idle";
  const backingText = hasBacking ? "backing" : "no backing";

  songTagEl.textContent = artist ? `${title} · ${artist}` : title;
  practiceTitleEl.textContent = artist ? `${title} — ${artist}` : title;
  practiceSubEl.textContent = timed ? `${modeText} · ${micText} · ${backingText}` : `${modeText} · ${micText}`;
  practicePosEl.textContent = `${songIdx + 1}/${loadedSong.chordSequence.length} · ${current}`;
  practiceNextEl.textContent = next ? `next ${next}` : "last chord";
}

// MIDI staged by the importer, carried to addSong() when the user clicks Add so
// the saved song keeps its backing track + channel list. Cleared after Add or
// when the paste box is edited away from the imported chart.
let pendingMidi: { b64: string; tracks: import("./library").BackingTrackInfo[] } | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// Parse the LLM's "barNumber: words" reply into a map, ignoring anything that
// isn't a valid `N: text` line or points outside 1..barCount. The LLM only
// supplies words; we never trust it with structure.
function parseBarLyrics(reply: string, barCount: number): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of reply.split(/\r?\n/)) {
    const mm = line.match(/^\s*(\d+)\s*[:.\)]\s*(.+)$/);
    if (!mm) continue;
    const n = parseInt(mm[1], 10);
    const words = mm[2].trim();
    if (n >= 1 && n <= barCount && words) m.set(n, words);
  }
  return m;
}

addSongBtn.addEventListener("click", async () => {
  const text = pasteBox.value.trim();
  if (!text) {
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "paste a tab first";
    return;
  }

  let source = text;
  const lyricTab = lyricsBox.value.trim();
  // mode: fuse a lyric tab onto a MIDI chart, simplify a MIDI chart, or convert
  // a messy pasted tab. (fuse needs both a staged MIDI and pasted lyrics.)
  const mode = pendingMidi && lyricTab ? "fuse" : pendingMidi ? "midi" : "messy";
  if (mode === "fuse" && aiEnhanceToggle.checked) {
    // Lyric fusion: the app OWNS the bar/chord structure. We send the LLM a
    // numbered bar list + the lyrics and ask only for "barN: words" lines, then
    // rebuild the ChordPro deterministically — so the bar count and chords can
    // never drift and the lyrics stay locked to the recording's timing.
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ laying lyrics over the timing…";
    try {
      const { header, bars } = parseChordChart(text);
      const numbered = bars.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const reply = await nativeInvoke<string>("enhance_tab", {
        raw: numbered,
        mode: "fuse",
        lyrics: lyricTab,
      });
      const lyricByBar = parseBarLyrics(reply, bars.length);
      source = buildFusedChordPro(header, bars, lyricByBar);
      libAddStatus.textContent = `laid ${lyricByBar.size} bars of lyrics over ${bars.length} bars`;
    } catch (e) {
      libAddStatus.textContent = `lyric fusion failed (${e}) — saved chart only`;
    } finally {
      addSongBtn.disabled = false;
    }
  } else if (mode === "fuse") {
    // can't fuse without the LLM; keep the timed chart, note the skip
    libAddStatus.textContent = "lyrics need ✨ AI enhance to merge — saved chart only";
  } else if (aiEnhanceToggle.checked) {
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ enhancing with AI…";
    try {
      const cleaned = await nativeInvoke<string>("enhance_tab", { raw: text, mode, lyrics: null });
      if (cleaned && cleaned.trim()) source = cleaned.trim();
    } catch (e) {
      libAddStatus.textContent = `AI enhance failed (${e}) — saved raw`;
    } finally {
      addSongBtn.disabled = false;
    }
  }

  let rec: SongRecord;
  try {
    rec = addSong(source, {
      title: songTitleInput.value,
      artist: songArtistInput.value,
      midi: pendingMidi?.b64,
      tracks: pendingMidi?.tracks,
    });
  } catch (e) {
    // most likely the localStorage quota (large MIDI imports) — surface it
    // instead of silently dropping the song.
    libAddStatus.classList.remove("done");
    libAddStatus.textContent =
      e instanceof LibraryFullError
        ? `couldn't save — ${e.message}. Delete a song and try again.`
        : `couldn't save: ${e}`;
    return;
  }
  if (!libAddStatus.textContent?.includes("failed")) {
    libAddStatus.classList.add("done");
    const withMidi = pendingMidi ? " · backing track ♪" : "";
    libAddStatus.textContent = `added "${rec.title}"${rec.artist ? " — " + rec.artist : ""}${withMidi}`;
  }
  pasteBox.value = "";
  songTitleInput.value = "";
  songArtistInput.value = "";
  lyricsBox.value = "";
  clearMidiStaging();
  renderSongList();
  loadSongIntoPlay(rec);
});

// dropping the imported chart text invalidates the staged MIDI association
pasteBox.addEventListener("input", () => {
  if (pendingMidi || importedMidi) clearMidiStaging();
});

// the parsed MIDI currently being reviewed (for the channel picker)
let importedMidi: MidiData | null = null;
let chordChannelSel: number[] | null = null;

function clearMidiStaging() {
  pendingMidi = null;
  importedMidi = null;
  chordChannelSel = null;
  chanPickerEl.hidden = true;
  lyricsBox.hidden = true;
}

// --- MIDI import: a .mid becomes a timed chord chart in the library ---
// We extract a chord-per-bar timeline (with tempo + bar markers) and feed the
// resulting ChordPro text through the same addSong() path as a pasted tab, so
// storage / parser / strip / highway all just work and it stays editable.
loadMidiBtn.addEventListener("click", () => midiInput.click());

midiInput.addEventListener("change", async () => {
  const file = midiInput.files?.[0];
  if (!file) return;
  libAddStatus.classList.remove("done");
  libAddStatus.textContent = `♪ reading ${file.name}…`;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const data = parseMidi(buf);
    const named = titleFromFilename(file.name);
    importedMidi = data;
    // auto-pick the chord channels (a default; the user can change it below).
    chordChannelSel = suggestChordChannels(data);
    if (!songTitleInput.value.trim()) songTitleInput.value = named.title;
    if (!songArtistInput.value.trim()) songArtistInput.value = named.artist;
    // stage the raw MIDI + track list so Add saves a backing track with it
    pendingMidi = { b64: bytesToBase64(buf), tracks: data.tracks };
    buildChannelPicker();
    lyricsBox.hidden = false; // offer to lay lyrics over the timed chart
    rederiveChart();
  } catch (e) {
    libAddStatus.textContent = `couldn't read MIDI: ${e}`;
  } finally {
    midiInput.value = ""; // allow re-selecting the same file
  }
});

// Build the channel chips for the imported MIDI; each shows the instrument
// name + a chordality score (higher = more chord-like). Toggling re-derives.
function buildChannelPicker() {
  if (!importedMidi) return;
  const scores = channelChordScores(importedMidi);
  chanChipsEl.innerHTML = "";
  // channels that actually sound notes (skip drums — never chords)
  const chans = importedMidi.tracks.filter((t) => !t.isDrums);
  if (!chans.length) {
    chanPickerEl.hidden = true;
    return;
  }
  for (const t of chans) {
    const on = chordChannelSel === null || chordChannelSel.includes(t.channel);
    const chip = document.createElement("button");
    chip.className = "chan-chip" + (on ? " on" : "");
    const sc = scores.get(t.channel) ?? 0;
    chip.innerHTML = `${escapeHtml(t.name)}<span class="ch-score">${sc.toFixed(1)}</span>`;
    chip.title = `${sc >= 1.5 ? "chordal" : "melodic / single-note"} — ${t.noteCount} notes`;
    chip.addEventListener("click", () => {
      // null means "all"; materialize to an explicit list on first toggle
      if (chordChannelSel === null) {
        chordChannelSel = chans.map((c) => c.channel);
      }
      if (chordChannelSel.includes(t.channel)) {
        chordChannelSel = chordChannelSel.filter((c) => c !== t.channel);
      } else {
        chordChannelSel.push(t.channel);
      }
      if (!chordChannelSel.length) chordChannelSel = null; // none -> treat as all
      buildChannelPicker();
      rederiveChart();
    });
    chanChipsEl.appendChild(chip);
  }
  chanPickerEl.hidden = false;
}

// Re-derive the chord chart text from the imported MIDI + current channel
// selection and drop it into the paste box (without clearing the staging).
function rederiveChart() {
  if (!importedMidi) return;
  const chart = midiToChordChart(importedMidi, {
    title: songTitleInput.value.trim() || undefined,
    artist: songArtistInput.value.trim() || undefined,
    collapseRuns: false,
    chordChannels: chordChannelSel,
  });
  // set value directly (programmatic set doesn't fire 'input', so staging stays)
  pasteBox.value = chart;
  const bars = parseChordChart(chart).bars.length;
  const src =
    chordChannelSel === null
      ? "all parts"
      : chordChannelSel.length === 1
        ? importedMidi.tracks.find((t) => t.channel === chordChannelSel![0])?.name ??
          `ch${chordChannelSel[0] + 1}`
        : `${chordChannelSel.length} parts`;
  libAddStatus.classList.add("done");
  libAddStatus.textContent = `${importedMidi.tempoBpm} bpm · ${bars} bars · chords from ${src} — review, then Add`;
}

function renderSongList() {
  const songs = listSongs();
  libCountEl.textContent = String(songs.length);
  songListEl.innerHTML = "";
  if (!songs.length) {
    songListEl.innerHTML = `<div class="song-list-empty">No songs yet. Paste a tab on the left to add one.</div>`;
    return;
  }
  for (const s of songs) {
    const row = document.createElement("div");
    row.className = "song-row";
    row.innerHTML = `
      <span class="s-title">${escapeHtml(s.title)}</span>
      <span class="s-artist">${escapeHtml(s.artist)}</span>
      <span class="s-meta">load →</span>
      <button class="s-edit" title="Rename">✎</button>
      <button class="s-del" title="Delete">✕</button>`;
    row.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("s-del")) {
        deleteSong(s.id);
        renderSongList();
        return;
      }
      if (t.classList.contains("s-edit")) {
        const title = prompt("Song title:", s.title);
        if (title === null) return;
        const artist = prompt("Artist:", s.artist) ?? s.artist;
        renameSong(s.id, title, artist);
        renderSongList();
        return;
      }
      loadSongIntoPlay(s);
    });
    songListEl.appendChild(row);
  }
}

// The list renders from the in-memory library, which starts on the
// localStorage seed; refresh it once the durable native store has loaded.
void libraryReady.then(() => {
  if (mode === "library") renderSongList();
});

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function loadSongIntoPlay(rec: SongRecord) {
  const song = getSong(rec.id);
  if (!song || !song.chordSequence.length) {
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "that song has no detectable chords";
    return;
  }
  loadedSong = song;
  loadedRecord = rec;
  songIdx = 0;
  setupTiming(song);
  setupBacking(rec);
  buildSongStrip();
  buildLyrics();
  buildArrangement();
  setTarget(song.chordSequence[0]);
  updatePracticeUi();
  // jump to Play
  (document.querySelector('[data-mode="play"]') as HTMLButtonElement)?.click();
}

// Configure backing audio for the loaded song. Default the selection to
// bass + drums (the rhythm section to play over); if the MIDI has neither,
// fall back to all non-lead channels.
function setupBacking(rec: SongRecord) {
  nativeInvoke("stop_backing").catch(() => {});
  hasBacking = !!rec.midi && !!rec.tracks?.length;
  backingTracks = rec.tracks ?? [];
  currentMidiB64 = rec.midi ?? null;
  if (!hasBacking) {
    backingControlsEl.hidden = true;
    updatePracticeUi();
    return;
  }
  const rhythm = backingTracks.filter((t) => t.isBass || t.isDrums).map((t) => t.channel);
  selectedChannels = rhythm.length ? rhythm : backingTracks.map((t) => t.channel);
  buildTrackPicker();
  backingControlsEl.hidden = false;
  loadBackingIntoEngine();
  updatePracticeUi();
}

// Send the MIDI + selected channels to the Rust synth (paused at start). The
// MIDI travels as base64 (decoded in Rust) — far cheaper over IPC than a JSON
// array of bytes.
function loadBackingIntoEngine() {
  if (!currentMidiB64) return;
  nativeInvoke("load_backing", { midi: currentMidiB64, channels: selectedChannels }).catch((e) => {
    // no SoundFont installed yet → prompt to download one; otherwise a transient
    // load failure shouldn't tear down the picker, so just log it.
    if (!maybeSoundfontError(e)) console.warn("load_backing failed", e);
  });
}

// Re-filter the already-loaded backing to the current channel selection without
// resending the file — preserves position/play state (used by the track picker).
function applyChannelSelection() {
  if (!currentMidiB64) return;
  nativeInvoke("set_backing_channels", { channels: selectedChannels }).catch((e) => {
    console.warn("set_backing_channels failed", e);
  });
}

// Build the beat-timeline for the loaded song. With a real tempo + bar markers
// (MIDI import) each chord occupies the bars until the next chord, so chord i
// sits at a known beat. Without tempo, the song is untimed (play-to-advance).
function setupTiming(song: Song) {
  stopTransport();
  songTime = 0;
  const seq = song.chordSequence;
  timed = song.tempo > 0 && seq.length > 0;
  chordBeat = [];
  if (!timed) {
    transportEl.hidden = true;
    arrTransportEl.hidden = true;
    songBeats = 0;
    updatePracticeUi();
    return;
  }
  secPerBeat = 60 / song.tempo;
  const beatsPerBar = (song.timeSig?.[0] ?? 4) * (4 / (song.timeSig?.[1] ?? 4));
  // each chord begins at a new bar when barStart[i]; chords sharing a bar split
  // it evenly. Walk the sequence accumulating bar positions.
  const hasBars = song.barStart.some(Boolean);
  let beat = 0;
  if (hasBars) {
    // group indices by bar (a new bar starts at barStart[i] or the first chord)
    for (let i = 0; i < seq.length; i++) {
      if (i === 0 || song.barStart[i]) {
        // count how many chords share this bar
        let n = 1;
        while (i + n < seq.length && !song.barStart[i + n]) n++;
        const per = beatsPerBar / n;
        for (let k = 0; k < n; k++) chordBeat[i + k] = beat + k * per;
        beat += beatsPerBar;
        i += n - 1;
      }
    }
  } else {
    // no bar info: one beat per chord
    for (let i = 0; i < seq.length; i++) chordBeat[i] = i;
    beat = seq.length;
  }
  songBeats = beat;
  tpBpmEl.textContent = `${Math.round(song.tempo)} bpm`;
  arrBpmEl.textContent = `${Math.round(song.tempo)} bpm`;
  tpTimeEl.textContent = "0:00";
  arrTimeEl.textContent = "0:00";
  transportEl.hidden = false;
  arrTransportEl.hidden = false;
  setPlayBtn(false);
  updatePracticeUi();
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Wait-mode: hold the playhead at each chord boundary until the player has
// played that chord cleanly, then resume. Encourages smooth, accurate playing.
let waitMode = false;
let waiting = false; // currently paused at a boundary, waiting for the chord

function setPlayBtn(on: boolean) {
  tpPlayBtn.textContent = on ? "❚❚" : "▶";
  tpPlayBtn.classList.toggle("on", on);
  arrPlayBtn.textContent = on ? "❚❚" : "▶";
  arrPlayBtn.classList.toggle("on", on);
  updatePracticeUi();
}

function startTransport() {
  if (!timed) return;
  playing = true;
  waiting = false;
  lastTickAt = performance.now();
  setPlayBtn(true);
  if (hasBacking) playBacking();
}

function stopTransport() {
  playing = false;
  waiting = false;
  setPlayBtn(false);
  if (hasBacking) nativeInvoke("pause_backing").catch(() => {});
}

function restartTransport() {
  songTime = 0;
  songIdx = 0;
  waiting = false;
  tpTimeEl.textContent = "0:00";
  arrTimeEl.textContent = "0:00";
  updateStrip();
  setTarget(loadedSong?.chordSequence[0] ?? "");
  if (hasBacking) {
    // reload from the top (rustysynth seeks via reload at pos 0)
    loadBackingIntoEngine();
    if (playing) playBacking();
  }
  updatePracticeUi();
}

// Move songIdx to the chord whose beat window contains `beat`; updates target.
function applyBeat(beat: number) {
  if (!loadedSong) return;
  let idx = songIdx;
  while (idx + 1 < chordBeat.length && chordBeat[idx + 1] <= beat) idx++;
  while (idx > 0 && chordBeat[idx] > beat) idx--;
  if (idx !== songIdx) {
    songIdx = idx;
    updateStrip();
    setTarget(loadedSong.chordSequence[idx]);
  }
}

// Whether the current chord has been played acceptably (used by wait-mode).
function currentChordSatisfied(): boolean {
  return isCleanHit(chord);
}

// advance the playhead each render frame. With backing audio, the Rust
// position drives us (synced via the `backing` event), so the wall-clock
// fallback here only runs for MIDI songs without audio. Wait-mode pauses the
// transport at the next chord boundary until the player nails the chord.
function tickTransport() {
  if (!playing || !timed || !loadedSong) return;

  // wait-mode gate: if we're holding for the player, resume once they play it
  if (waiting) {
    if (currentChordSatisfied()) {
      waiting = false;
      updatePracticeUi(); // no longer refreshed every frame
      if (hasBacking) playBacking();
    } else {
      lastTickAt = performance.now();
      return; // stay parked on this chord
    }
  }

  if (hasBacking) {
    // position comes from the `backing` event (syncBackingPos); nothing to
    // integrate here. Wait-mode boundary checks still run below via beat.
    return;
  }

  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTickAt) / 1000); // clamp big gaps
  lastTickAt = now;
  songTime += dt;
  const beat = songTime / secPerBeat;
  tpTimeEl.textContent = fmtTime(songTime);
  arrTimeEl.textContent = fmtTime(songTime);
  maybeWaitAtBoundary(beat);
  if (!waiting) applyBeat(beat);
  // loop at the end
  if (beat >= songBeats) {
    songTime = 0;
    songIdx = 0;
    updateStrip();
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
    // clamp the playhead just before the boundary so we don't advance
    songTime = chordBeat[next] * secPerBeat - 0.001;
    if (hasBacking) nativeInvoke("pause_backing").catch(() => {});
    updatePracticeUi();
  }
}

// Called from the `backing` event: the Rust playback position is authoritative
// when audio is playing, so map it onto the highway playhead.
function syncBackingPos(pos: number) {
  if (!timed || !loadedSong || !hasBacking) return;
  songTime = pos;
  const beat = pos / secPerBeat;
  tpTimeEl.textContent = fmtTime(pos);
  arrTimeEl.textContent = fmtTime(pos);
  maybeWaitAtBoundary(beat);
  if (!waiting) applyBeat(beat);
}

tpPlayBtn.addEventListener("click", () => (playing ? stopTransport() : startTransport()));
tpRestartBtn.addEventListener("click", restartTransport);
arrPlayBtn.addEventListener("click", () => (playing ? stopTransport() : startTransport()));
arrRestartBtn.addEventListener("click", restartTransport);

tpWaitBtn.addEventListener("click", () => {
  waitMode = !waitMode;
  tpWaitBtn.classList.toggle("on", waitMode);
  if (!waitMode && waiting) {
    waiting = false;
    if (playing && hasBacking) playBacking();
  }
  updatePracticeUi();
});

tpTracksBtn.addEventListener("click", () => {
  trackPickerEl.hidden = !trackPickerEl.hidden;
});

// Build the channel checklist; toggling reloads the backing with the new mix.
function buildTrackPicker() {
  trackPickerEl.innerHTML = "";
  for (const t of backingTracks) {
    const on = selectedChannels.includes(t.channel);
    const row = document.createElement("label");
    row.className = "track-opt";
    row.innerHTML =
      `<input type="checkbox" ${on ? "checked" : ""} /> ` +
      `<span>${escapeHtml(t.name)}</span>` +
      `<span class="t-meta">${t.isDrums ? "drums" : t.isBass ? "bass" : "ch" + (t.channel + 1)} · ${t.noteCount}</span>`;
    const cb = row.querySelector("input") as HTMLInputElement;
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!selectedChannels.includes(t.channel)) selectedChannels.push(t.channel);
      } else {
        selectedChannels = selectedChannels.filter((c) => c !== t.channel);
      }
      // re-filter in place: keeps the current position + play state (no reload,
      // no resend of the file), so the song doesn't restart on a toggle.
      applyChannelSelection();
    });
    trackPickerEl.appendChild(row);
  }
}

function buildSongStrip() {
  songStrip.innerHTML = "";
  stripChordEls = [];
  if (!loadedSong) return;
  songBarEmpty.hidden = true;
  songStrip.hidden = false;
  const hasBars = loadedSong.barStart.some(Boolean);
  loadedSong.chordSequence.forEach((ch, i) => {
    // bar separator before any chord (except the first) that starts a measure
    if (hasBars && i > 0 && loadedSong!.barStart[i]) {
      const sep = document.createElement("span");
      sep.className = "bar-sep";
      songStrip.appendChild(sep);
    }
    const el = document.createElement("span");
    el.className = "strip-chord";
    el.textContent = ch;
    el.addEventListener("click", () => {
      songIdx = stripChordEls.indexOf(el);
      updateStrip();
      setTarget(ch);
    });
    songStrip.appendChild(el);
    stripChordEls.push(el);
  });
  updateStrip();
}

function updateStrip() {
  stripChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < songIdx);
    el.classList.toggle("current", i === songIdx);
  });
  // keep the current chord in view
  stripChordEls[songIdx]?.scrollIntoView({ block: "nearest", inline: "center" });
  updateLyrics();
  updateArrangementState();
  updatePracticeUi();
}

type ArrangementChord = {
  name: string;
  idx: number;
  firstInBar: boolean;
};

function arrangementBarsForLine(line: SongLine, startIdx: number): ArrangementChord[][] {
  const bars: ArrangementChord[][] = [];
  const hasBarMarkers = line.barStart.some(Boolean);
  line.chords.forEach((name, i) => {
    const startsBar = i === 0 || line.barStart[i] || (!hasBarMarkers && i > 0 && i % 4 === 0);
    if (startsBar || !bars.length) bars.push([]);
    bars[bars.length - 1].push({ name, idx: startIdx + i, firstInBar: startsBar });
  });
  return bars;
}

function buildArrangement() {
  arrangementSheetEl.innerHTML = "";
  arrangementChordsEl.innerHTML = "";
  arrangementChordEls = [];
  arrangementLineOfIdx = [];
  arrangementChordCards = new Map();
  lastArrangementScrollIdx = -1;

  if (!loadedSong) {
    arrangementTagEl.textContent = "no song";
    arrangementChordTagEl.textContent = "baritone";
    arrangementEmptyEl.hidden = false;
    arrangementSheetEl.hidden = true;
    updateArrangementState();
    return;
  }

  arrangementEmptyEl.hidden = true;
  arrangementSheetEl.hidden = false;
  const title = loadedRecord?.title || loadedSong.title || "Untitled";
  const artist = loadedRecord?.artist || loadedSong.artist;
  arrangementTagEl.textContent = artist ? `${title} · ${artist}` : title;
  arrangementChordTagEl.textContent = `${loadedSong.uniqueChords.length} shapes`;

  let globalIdx = 0;
  for (const line of loadedSong.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "arr-section";
      sec.textContent = line.section;
      arrangementSheetEl.appendChild(sec);
      continue;
    }

    const hasContent = line.chords.length || line.lyric.trim();
    if (!hasContent) continue;

    const row = document.createElement("div");
    row.className = "arr-line";
    if (!line.chords.length) row.classList.add("lyric-only");

    if (line.chords.length) {
      const chordRow = document.createElement("div");
      chordRow.className = "arr-chord-row";
      for (const bar of arrangementBarsForLine(line, globalIdx)) {
        const barEl = document.createElement("div");
        barEl.className = "arr-bar";
        for (const item of bar) {
          const chordEl = document.createElement("button");
          chordEl.className = "arr-chord";
          chordEl.type = "button";
          chordEl.textContent = item.name;
          chordEl.addEventListener("click", () => jumpToChord(item.idx));
          barEl.appendChild(chordEl);
          arrangementChordEls[item.idx] = chordEl;
          arrangementLineOfIdx[item.idx] = row;
        }
        chordRow.appendChild(barEl);
      }
      row.appendChild(chordRow);
    }

    const lyric = document.createElement("div");
    lyric.className = "arr-lyric";
    lyric.textContent = line.lyric.trim() || "instrumental";
    row.appendChild(lyric);
    arrangementSheetEl.appendChild(row);
    globalIdx += line.chords.length;
  }

  const counts = new Map<string, number>();
  loadedSong.chordSequence.forEach((ch) => counts.set(ch, (counts.get(ch) ?? 0) + 1));
  loadedSong.uniqueChords.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "arr-chord-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Jump to first ${ch}`);
    const state = chordShapeState(ch);
    card.innerHTML =
      `<span class="arr-card-head">` +
      `<span class="arr-card-name">${escapeHtml(ch)}</span>` +
      `<span class="arr-card-meta"><span class="arr-card-count">${counts.get(ch) ?? 0}x</span><span class="arr-card-shape">${state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1"}</span></span>` +
      `<span class="arr-card-actions">` +
      `<button class="arr-shape-btn arr-shape-prev" title="Previous fingering">&lsaquo;</button>` +
      `<button class="arr-shape-btn arr-shape-next" title="Next fingering">&rsaquo;</button>` +
      `</span>` +
      `</span>` +
      `<svg class="arr-mini-fret" viewBox="0 0 150 200" aria-label="${escapeHtml(ch)} fingering"></svg>`;
    const firstIdx = loadedSong!.chordSequence.indexOf(ch);
    card.addEventListener("click", () => jumpToChord(firstIdx));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      jumpToChord(firstIdx);
    });
    card.querySelector(".arr-shape-prev")?.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleChordShape(ch, -1);
    });
    card.querySelector(".arr-shape-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleChordShape(ch, 1);
    });
    arrangementChordsEl.appendChild(card);
    arrangementChordCards.set(ch, card);
    drawFretboard(
      ch,
      false,
      "Up Next",
      {
        svg: card.querySelector(".arr-mini-fret")!,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });

  redrawArrangementChordCards();
  updateArrangementState(true);
}

function updateArrangementState(forceScroll = false) {
  const next = nextDistinctChordInfo();
  if (!loadedSong) {
    arrangementNowEl.textContent = "--";
    arrangementNextEl.textContent = "--";
    arrangementCountEl.textContent = "--";
    return;
  }

  const current = loadedSong.chordSequence[songIdx] ?? "--";
  arrangementNowEl.textContent = current;
  arrangementNextEl.textContent = next.name || "end";
  arrangementCountEl.textContent = `${songIdx + 1}/${loadedSong.chordSequence.length}`;

  arrangementChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < songIdx);
    el.classList.toggle("now", i === songIdx);
    el.classList.toggle("next", next.index >= 0 && i === next.index);
  });

  const curLine = arrangementLineOfIdx[songIdx];
  arrangementSheetEl.querySelectorAll(".arr-line").forEach((line) => {
    line.classList.toggle("now", line === curLine);
  });

  arrangementChordCards.forEach((card, name) => {
    card.classList.toggle("now", name === current);
    card.classList.toggle("next", !!next.name && name === next.name);
  });

  if ((forceScroll || lastArrangementScrollIdx !== songIdx) && curLine && !arrangementView.hidden) {
    curLine.scrollIntoView({ block: "center" });
    lastArrangementScrollIdx = songIdx;
  }
}

// Canvas chord highway: tokens slide down toward a gold NOW line. When the song
// is timed, position comes from the wall-clock playhead (Rocksmith-style);
// otherwise it's a static lane of upcoming chords fanning up from songIdx.
function drawHighway() {
  const dpr = window.devicePixelRatio || 1;
  const rect = highway.getBoundingClientRect();
  const w = rect.width || 360;
  const h = rect.height || 260;
  if (highway.width !== Math.round(w * dpr) || highway.height !== Math.round(h * dpr)) {
    highway.width = Math.round(w * dpr);
    highway.height = Math.round(h * dpr);
  }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const nowY = h - 64; // NOW line sits just above the big current chord
  const topY = 28;
  const TEAL = "25,227,196";
  const GOLD = "245,196,81";

  if (!loadedSong) return;
  const seq = loadedSong.chordSequence;

  // perspective rails converging toward NOW
  hctx.strokeStyle = `rgba(${TEAL},0.12)`;
  hctx.lineWidth = 1;
  [[-1, 0.42, -1, 0.12], [1, 0.42, 1, 0.12]].forEach(([s, tb, , tt]) => {
    hctx.beginPath();
    hctx.moveTo(cx + (s as number) * w * (tt as number), topY);
    hctx.lineTo(cx + (s as number) * w * (tb as number), nowY);
    hctx.stroke();
  });

  // playhead beat (timed) or a synthetic position from songIdx (untimed)
  const headBeat = timed ? songTime / secPerBeat : (chordBeat[songIdx] ?? songIdx);

  // draw upcoming tokens from nearest-future back, mapping beat-distance to y
  for (let i = 0; i < seq.length; i++) {
    const tb = timed ? chordBeat[i] : i;
    const rel = tb - headBeat; // beats ahead of the playhead (0 = at NOW)
    if (rel < -0.6) continue; // already passed
    if (rel > LOOKAHEAD_BEATS) break; // too far ahead
    const prog = Math.max(0, Math.min(1, rel / LOOKAHEAD_BEATS)); // 0 near .. 1 far
    const y = nowY - prog * (nowY - topY);
    const scale = 1 - prog * 0.55;
    const alpha = 1 - prog * 0.78;
    const isNow = rel < (timed ? 0.5 : 0.5) && i === songIdx;
    const col = isNow ? GOLD : TEAL;
    const tw = 60 * scale;
    const th = 30 * scale;
    roundRect(hctx, cx - tw / 2, y - th / 2, tw, th, 8 * scale);
    hctx.globalAlpha = alpha;
    hctx.strokeStyle = `rgba(${col},${isNow ? 0.95 : 0.55})`;
    hctx.lineWidth = 1.5 * scale;
    hctx.shadowColor = `rgba(${col},0.7)`;
    hctx.shadowBlur = isNow ? 14 : 6 * scale;
    hctx.stroke();
    hctx.fillStyle = `rgba(${col},0.06)`;
    hctx.fill();
    hctx.shadowBlur = 0;
    hctx.fillStyle = `rgba(${col},${isNow ? 1 : 0.9})`;
    hctx.font = `700 ${Math.round(22 * scale)}px "Chakra Petch", sans-serif`;
    hctx.textAlign = "center";
    hctx.textBaseline = "middle";
    hctx.fillText(seq[i], cx, y + 1);
    hctx.globalAlpha = 1;
  }

  // gold NOW line
  hctx.shadowColor = `rgba(${GOLD},0.8)`;
  hctx.shadowBlur = 14;
  hctx.strokeStyle = `rgba(${GOLD},0.95)`;
  hctx.lineWidth = 2;
  hctx.beginPath();
  hctx.moveTo(w * 0.12, nowY);
  hctx.lineTo(w * 0.88, nowY);
  hctx.stroke();
  hctx.shadowBlur = 0;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Build the lyric DOM: one row per non-empty SongLine, with chord cues
// positioned above the syllable they fall on (using chordPos). A flat map
// from global chord index -> token element drives the gold highlight.
function buildLyrics() {
  lyricsView.innerHTML = "";
  lyricTokenEls = [];
  lyricLineOfIdx = [];
  if (!loadedSong) {
    lyricsView.hidden = true;
    return;
  }
  lyricsView.hidden = false;

  let globalIdx = 0; // running index into chordSequence
  for (const line of loadedSong.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "lyric-section";
      sec.textContent = line.section;
      lyricsView.appendChild(sec);
      continue;
    }
    if (!line.chords.length && !line.lyric.trim()) continue;

    const row = document.createElement("div");
    row.className = "lyric-line";

    if (!line.lyric.trim()) {
      // chord-only (intro/instrumental) line: render chords as bare cues
      row.classList.add("instrumental");
      line.chords.forEach((ch) => {
        const tok = document.createElement("span");
        tok.className = "lyric-tok bare";
        tok.innerHTML = `<span class="chord-cue">${escapeHtml(ch)}</span>`;
        const gi = globalIdx;
        tok.addEventListener("click", () => jumpToChord(gi));
        row.appendChild(tok);
        lyricTokenEls[gi] = tok;
        lyricLineOfIdx[gi] = row;
        globalIdx++;
      });
      lyricsView.appendChild(row);
      continue;
    }

    // lyric line: split into segments at each chord position, wrapping the
    // word starting at that position in a token that carries the cue above it.
    const lyric = line.lyric;
    // boundaries where a chord sits, sorted with their chord index
    const cuts = line.chords
      .map((ch, i) => ({ ch, i, pos: Math.min(line.chordPos[i] ?? 0, lyric.length) }))
      .sort((a, b) => a.pos - b.pos);

    let cursor = 0;
    for (let k = 0; k < cuts.length; k++) {
      const { ch, pos } = cuts[k];
      // plain text before this chord position
      if (pos > cursor) {
        row.appendChild(document.createTextNode(lyric.slice(cursor, pos)));
        cursor = pos;
      }
      // the word/run this chord cue sits over: up to the next chord cut, but
      // at least to the end of the current word (don't split mid-word visually)
      const nextPos = k + 1 < cuts.length ? cuts[k + 1].pos : lyric.length;
      let end = nextPos;
      // extend to the end of the current word so the underline glow hugs it
      const wordEnd = (() => {
        let e = pos;
        while (e < lyric.length && !/\s/.test(lyric[e])) e++;
        return e;
      })();
      if (wordEnd > end && wordEnd <= lyric.length) end = wordEnd;
      if (end <= cursor) end = Math.min(cursor + 1, lyric.length);

      const tok = document.createElement("span");
      tok.className = "lyric-tok";
      const wordText = lyric.slice(cursor, end) || "·";
      tok.innerHTML =
        `<span class="chord-cue">${escapeHtml(ch)}</span>` +
        `<span class="syll">${escapeHtml(wordText)}</span>`;
      const gi = globalIdx;
      tok.addEventListener("click", () => jumpToChord(gi));
      row.appendChild(tok);
      lyricTokenEls[gi] = tok;
      lyricLineOfIdx[gi] = row;
      globalIdx++;
      cursor = end;
    }
    // trailing text after the last chord
    if (cursor < lyric.length) {
      row.appendChild(document.createTextNode(lyric.slice(cursor)));
    }
    lyricsView.appendChild(row);
  }
  updateLyrics();
}

// Move highlight to the token at songIdx, brighten its line, autoscroll.
function updateLyrics() {
  if (!loadedSong) return;
  const curLine = lyricLineOfIdx[songIdx];
  lyricTokenEls.forEach((tok, i) => {
    if (tok) tok.classList.toggle("lit", i === songIdx);
  });
  lyricsView.querySelectorAll(".lyric-line").forEach((l) => {
    l.classList.toggle("now", l === curLine);
  });
  lyricTokenEls[songIdx]?.scrollIntoView({ block: "nearest" });
}

// Clicking a lyric cue jumps the target to that chord (same path as a strip
// chip): set songIdx, refresh both views, and tell the detector the new target.
function jumpToChord(idx: number) {
  if (!loadedSong || idx < 0 || idx >= loadedSong.chordSequence.length) return;
  songIdx = idx;
  updateStrip();
  setTarget(loadedSong.chordSequence[idx]);
}

// advance to the next chord when the current one is played cleanly. Only for
// UNTIMED songs — when a song is timed, the transport playhead owns the
// position and we don't want a good strum to skip ahead of the music.
function maybeAdvance(reading: ChordReading) {
  if (!loadedSong || !targetChord || timed) return;
  const hit = isCleanHit(reading);
  if (hit) {
    advanceHold++;
    // require a few consecutive good frames (~0.25s) to avoid double-skips
    if (advanceHold >= 4 && songIdx < loadedSong.chordSequence.length - 1) {
      songIdx++;
      advanceHold = 0;
      updateStrip();
      setTarget(loadedSong.chordSequence[songIdx]);
    }
  } else {
    advanceHold = 0;
  }
}

nativeListen<ChordReading>("chord", (event) => {
  chord = event.payload;
  lastChordAt = performance.now();
  setConn(true);
  noteRms(event.payload.rms);
  maybeAdvance(event.payload);
});

// backing-track playback position from Rust drives the highway playhead
interface BackingStatus {
  playing: boolean;
  pos: number;
  length: number;
  loaded: boolean;
}
nativeListen<BackingStatus>("backing", (event) => {
  if (event.payload.playing) syncBackingPos(event.payload.pos);
});

// ---- SoundFont install/download ----
// Backing playback renders MIDI through a General MIDI SoundFont. None is
// bundled (the good banks aren't free to redistribute), so the Rust side
// resolves one from disk and returns the "no-soundfont" sentinel until the
// user installs one. This panel downloads a free SoundFont or explains how to
// supply your own.
interface SoundfontInfo {
  installed: boolean;
  path: string | null;
  data_dir: string;
}
let soundfontInstalled = false;

// True if `e` was the missing-SoundFont sentinel (and the panel was shown), so
// callers can skip their own logging.
function maybeSoundfontError(e: unknown): boolean {
  if (typeof e === "string" && e.includes("no-soundfont")) {
    showSoundfontPanel();
    return true;
  }
  return false;
}

function playBacking(): void {
  if (!soundfontInstalled) {
    showSoundfontPanel();
    return;
  }
  nativeInvoke("play_backing").catch((e) => {
    if (!maybeSoundfontError(e)) console.warn("play_backing failed", e);
  });
}

function showSoundfontPanel(): void {
  sfOverlayEl.hidden = false;
}
function hideSoundfontPanel(): void {
  sfOverlayEl.hidden = true;
}

async function refreshSoundfontStatus(): Promise<void> {
  try {
    const info = await nativeInvoke<SoundfontInfo>("soundfont_status");
    soundfontInstalled = info.installed;
    if (info.data_dir) sfPathEl.textContent = info.data_dir;
  } catch {
    /* browser build (no native runtime): leave defaults */
  }
}
void refreshSoundfontStatus();

sfCloseBtn.addEventListener("click", hideSoundfontPanel);
sfOverlayEl.addEventListener("click", (e) => {
  if (e.target === sfOverlayEl) hideSoundfontPanel();
});
sfOpenFolderBtn.addEventListener("click", () => {
  nativeInvoke("open_data_dir").catch((e) => console.warn("open_data_dir failed", e));
});

// Mobile platforms have no user-facing file manager to open into the app's
// sandbox; hide desktop-only affordances and give CSS a hook (body.mobile)
// for touch-sized layout tweaks beyond what width queries catch.
void nativeInvoke<string>("platform")
  .then((os) => {
    if (os === "ios" || os === "android") {
      document.body.classList.add("mobile");
      sfOpenFolderBtn.hidden = true;
    }
  })
  .catch(() => {});

nativeListen<{ received: number; total: number }>("soundfont_progress", (event) => {
  const { received, total } = event.payload;
  const mb = (n: number) => (n / 1e6).toFixed(1);
  if (total > 0) {
    sfProgressEl.max = total;
    sfProgressEl.value = received;
    sfStatusEl.textContent = `${mb(received)} / ${mb(total)} MB`;
  } else {
    sfProgressEl.removeAttribute("value"); // indeterminate
    sfStatusEl.textContent = `${mb(received)} MB`;
  }
});

sfDownloadBtn.addEventListener("click", async () => {
  sfDownloadBtn.disabled = true;
  sfProgressEl.hidden = false;
  sfProgressEl.value = 0;
  sfStatusEl.classList.remove("err");
  sfStatusEl.textContent = "Starting…";
  try {
    await nativeInvoke<string>("download_soundfont");
    soundfontInstalled = true;
    await refreshSoundfontStatus();
    hideSoundfontPanel();
    // pick up the new SoundFont for the currently-loaded song, if any
    if (hasBacking) loadBackingIntoEngine();
  } catch (e) {
    sfStatusEl.classList.add("err");
    sfStatusEl.textContent = typeof e === "string" ? e : "Download failed";
  } finally {
    sfDownloadBtn.disabled = false;
    sfProgressEl.hidden = true;
  }
});

// --- AI enhance endpoint (Setup screen) ---
// Saved through the Rust side into app-data settings.json; env vars
// UKEJAM_PROXY_URL/KEY still override saved values at request time.
interface ProxySettings {
  proxy_url: string;
  proxy_key: string;
}
const proxyUrlInput = document.getElementById("proxy-url") as HTMLInputElement;
const proxyKeyInput = document.getElementById("proxy-key") as HTMLInputElement;
const proxySaveBtn = document.getElementById("proxy-save") as HTMLButtonElement;
const proxyStatus = document.getElementById("proxy-status")!;

void nativeInvoke<ProxySettings>("get_settings")
  .then((s) => {
    proxyUrlInput.value = s.proxy_url;
    proxyKeyInput.value = s.proxy_key;
  })
  .catch(() => {});

proxySaveBtn.addEventListener("click", async () => {
  try {
    await nativeInvoke("set_settings", {
      settings: {
        proxy_url: proxyUrlInput.value.trim(),
        proxy_key: proxyKeyInput.value.trim(),
      },
    });
    proxyStatus.classList.add("done");
    proxyStatus.textContent = proxyUrlInput.value.trim()
      ? "saved — AI enhance will use this endpoint"
      : "saved — using the default local proxy";
  } catch (e) {
    proxyStatus.classList.remove("done");
    proxyStatus.textContent = `save failed: ${e}`;
  }
});

// --- mic calibration (Setup screen) ---
const calibrateBtn = document.getElementById("calibrate-btn") as HTMLButtonElement;
const setupStatus = document.getElementById("setup-status")!;

calibrateBtn.addEventListener("click", async () => {
  if (calibrating) return;
  calibrating = true;
  calibSamples = [];
  calibrateBtn.disabled = true;
  setupStatus.classList.remove("done");
  setupStatus.textContent = "measuring… stay silent";
  try {
    await nativeInvoke("start_tuner"); // any capture mode emits rms
    await new Promise((r) => setTimeout(r, 2000));
    await nativeInvoke("stop_audio");
    // robust noise floor: 90th percentile of measured silence
    let gate = 0.012;
    if (calibSamples.length) {
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1];
      gate = Math.max(0.006, floor * 4); // gate = noise floor x4
    }
    await nativeInvoke("set_gate", { gate });
    setupStatus.classList.add("done");
    setupStatus.textContent = `calibrated · gate ${gate.toFixed(4)} (this session)`;
  } catch (e) {
    setupStatus.textContent = `calibration error: ${e}`;
  } finally {
    calibrating = false;
    calibrateBtn.disabled = false;
    setConn(false);
  }
});

// Render the target chord-tones as present/missing tokens (the "where your
// fingers are wrong" visual). Pulls the target chord's pitch classes and marks
// each present unless the detector reports it missing; appends any extras.
function renderBreakdown(reading: ChordReading | null) {
  if (!targetChord) {
    targetNotesEl.innerHTML = "";
    return;
  }
  const pcs = chordPitchClasses(targetChord);
  const missingPcs = new Set((reading?.missing ?? []).map((n) => pcNameToIndex(n)));
  const active = !!reading?.active;
  let html = "";
  for (const pc of pcs) {
    const present = active && !missingPcs.has(pc);
    const cls = !active ? "" : present ? "present" : "missing";
    const mark = !active ? "" : present ? "✓" : "!";
    html += `<div class="note-tok ${cls}"><span>${PITCH_CLASSES[pc]}</span>${
      mark ? `<span class="mark">${mark}</span>` : ""
    }</div>`;
  }
  for (const ex of reading?.extra ?? []) {
    const pc = pcNameToIndex(ex);
    if (pc < 0 || pcs.includes(pc)) continue;
    html += `<div class="note-tok extra"><span>${PITCH_CLASSES[pc]}</span><span class="nm">extra</span><span class="mark">+</span></div>`;
  }
  targetNotesEl.innerHTML = html;
}

// map a note name like "G" / "F#" / "Bb" / "G3" to a pitch-class index 0..11
function pcNameToIndex(name: string): number {
  if (!name) return -1;
  const m = name.trim().match(/^([A-G])(#|b)?/);
  if (!m) return -1;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1]];
  if (m[2] === "#") pc = (pc + 1) % 12;
  if (m[2] === "b") pc = (pc + 11) % 12;
  return pc;
}

function renderChords() {
  // This loop only paints the Play view. On other views, skip all the canvas /
  // DOM work but keep the transport tick alive on the Arrangement view so a
  // timed song without backing audio (wall-clock playhead) still advances.
  if (mode !== "play" && mode !== "arrangement") {
    requestAnimationFrame(renderChords);
    return;
  }
  if (mode === "arrangement") {
    tickTransport();
    requestAnimationFrame(renderChords);
    return;
  }
  const now = performance.now();
  if (chordListening && now - lastChordAt > 300) {
    chord = { active: false, detected: "", cleanliness: 0, chroma: new Array(12).fill(0), spectrum: new Array(FFT_BINS).fill(0), missing: [], extra: [], rms: 0 };
    if (now - lastChordAt > 1500) setConn(false);
  }

  const c = chord;
  let fretboardMatched = false;
  const targetPcs = chordPitchClasses(targetChord);
  // FFT gold highlight follows the target chord if set, else the detected one
  fftGoldPCs = targetChord
    ? targetPcs
    : c && c.active && c.detected
      ? chordPitchClasses(c.detected)
      : [];
  if (c && c.active) {
    const pct = Math.round(c.cleanliness * 100);
    const clean = c.cleanliness >= 0.85;
    // hero chord = what to play (target) when a song is loaded; the detected
    // chord otherwise. For target chords, use the same tolerant note-diff hit
    // rule as the coach and auto-advance so the screen gives one verdict.
    const matched = targetChord ? isCleanHit(c) : !!c.detected;
    fretboardMatched = matched;
    const hero = targetChord || c.detected || "—";
    chordNameEl.textContent = hero;
    chordNameEl.className = "chord-name " + (matched ? "clean" : "dirty");
    chordSubEl.textContent = targetChord
      ? matched ? "Locked in" : `heard ${c.detected || "—"}`
      : "Playing";
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    cleanValEl.innerHTML = `${pct}<span class="pct">%</span>`;
    cleanStatusEl.textContent = clean ? "clean" : pct >= 70 ? "almost" : "off";
    cleanTargetEl.textContent = targetChord ? `target · ${targetChord}` : "free play";

    // coach text from missing/extra
    if (!targetChord) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">free play</span> · heard <b>${c.detected || "—"}</b>`;
    } else if (isCleanHit(c)) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">nice — that's a clean ${targetChord} ✓</span>`;
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
    for (let i = 0; i < 12; i++) {
      const v = Math.max(0, Math.min(1, c.chroma[i] || 0));
      chromaFills[i].style.height = `${(4 + v * 92).toFixed(1)}%`;
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }

    // spectrum: ease smoothed buffer toward incoming 96 real bins
    for (let i = 0; i < FFT_BINS; i++) {
      const v = c.spectrum && i < c.spectrum.length ? c.spectrum[i] : 0;
      smoothSpec[i] += (v - smoothSpec[i]) * 0.25;
    }

    // analyzer: match% follows cleanliness vs the target (or detection conf)
    mMatchEl.textContent = `${pct}%`;
    mfMatchEl.style.width = `${pct}%`;
    mfMatchEl.classList.toggle("gold", !matched);

    const nowFb = currentFretboardChord(c.detected, matched);
    const nextFb = nextFretboardChord();
    lastCurrentFretChord = drawFretboard(
      nowFb.name,
      nowFb.played,
      "Now",
      { svg: currentFretboardEl, title: currentFingerTitleEl, tag: currentFingerTagEl },
      lastCurrentFretChord
    );
    lastNextFretChord = drawFretboard(
      nextFb.name,
      nextFb.played,
      "Up Next",
      { svg: fretboardEl, title: fingerTitleEl, tag: fingerTagEl },
      lastNextFretChord
    );
  } else {
    chordNameEl.textContent = targetChord || "—";
    chordNameEl.className = "chord-name";
    chordSubEl.textContent = targetChord ? "Play this" : "Playing";
    smoothClean += (0 - smoothClean) * 0.15;
    cleanValEl.innerHTML = `0<span class="pct">%</span>`;
    cleanStatusEl.textContent = chordListening ? "listening…" : "idle";
    cleanTargetEl.textContent = targetChord ? `target · ${targetChord}` : "free play";
    coachEl.className = "coach good";
    coachEl.textContent = chordListening ? "play a chord" : "press start to listen";
    renderBreakdown(null);
    mMatchEl.textContent = "—";
    mfMatchEl.style.width = "0%";
    for (let i = 0; i < 12; i++) {
      chromaFills[i].style.height = "4%";
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }
    // flat FFT when idle
    for (let i = 0; i < FFT_BINS; i++) smoothSpec[i] += (0 - smoothSpec[i]) * 0.2;
    const nowFb = currentFretboardChord("", false);
    const nextFb = nextFretboardChord();
    lastCurrentFretChord = drawFretboard(
      nowFb.name,
      nowFb.played,
      "Now",
      { svg: currentFretboardEl, title: currentFingerTitleEl, tag: currentFingerTagEl },
      lastCurrentFretChord
    );
    lastNextFretChord = drawFretboard(
      nextFb.name,
      nextFb.played,
      "Up Next",
      { svg: fretboardEl, title: fingerTitleEl, tag: fingerTagEl },
      lastNextFretChord
    );
  }

  tickTransport();
  updateFretboardPanelState(fretboardMatched);
  drawHighway();
  drawGauge(smoothClean, c?.active ?? false);
  drawFFT();
  requestAnimationFrame(renderChords);
}

// minimal chord -> pitch-class map for the chromagram target highlight
// Normalize the many ways tabs write a chord into our canonical name:
// flat roots -> sharps, quality aliases (m7-5/ø -> m7b5, °->dim, +->aug, maj->"")
// and strip slash-bass (D/F# -> D) for fingering/diagram purposes.
const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#",
};
function normalizeChord(name: string): string {
  if (!name) return "";
  let n = name.trim().split("/")[0].trim(); // drop slash bass
  const m = n.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return n;
  let root = m[1] + (m[2] ?? "");
  if (FLAT_TO_SHARP[root]) root = FLAT_TO_SHARP[root];
  let q = m[3].trim();
  // quality aliases
  q = q
    .replace(/^maj$/i, "")
    .replace(/^M$/, "")
    .replace(/^(min|−|-)/, "m")
    .replace(/m7[-b]5/i, "m7b5")
    .replace(/ø7?/i, "m7b5")
    .replace(/°7/i, "dim7")
    .replace(/(°|dim)$/i, "dim")
    .replace(/\+/, "aug")
    .replace(/^maj7/i, "maj7")
    .replace(/^M7/, "maj7");
  return root + q;
}

function chordPitchClasses(rawName: string): number[] {
  const name = normalizeChord(rawName);
  if (!name) return [];
  const m = name.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return [];
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1]];
  if (m[2] === "#") root = (root + 1) % 12;
  if (m[2] === "b") root = (root + 11) % 12;
  const q = m[3];
  const intervals: Record<string, number[]> = {
    "": [0, 4, 7],
    m: [0, 3, 7],
    "7": [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    dim: [0, 3, 6],
    dim7: [0, 3, 6, 9],
    aug: [0, 4, 8],
    m7b5: [0, 3, 6, 10],
    "6": [0, 4, 7, 9],
    m6: [0, 3, 7, 9],
    add9: [0, 4, 7, 2],
    "7sus4": [0, 5, 7, 10],
    "5": [0, 7],
  };
  const iv = intervals[q] ?? [0, 4, 7];
  return iv.map((x) => (root + x) % 12);
}

// Open-string pitch classes for baritone D-G-B-E (low->high).
const OPEN_PC = [2, 7, 11, 4];

// Fallback voicing generator: when a chord isn't in the verified VOICINGS
// table (e.g. F#maj7 and many 7th/m7 qualities the MIDI import surfaces),
// derive a playable shape. For each string we list the fret that lands on each
// chord tone (within a low window), then search the small space of one-pick-
// per-string combinations for a shape that covers EVERY chord tone, preferring
// open strings, low frets, and a tight span. Greedy lowest-fret-per-string
// fails (it can grab a different tone and never cover the root/3rd), so we
// search. Verified to only ever show chord tones.
const MAX_FRET = 7;
function voicingKey(v: Voicing): string {
  return v.map((f) => (f === null ? "x" : String(f))).join(",");
}

function addUniqueVoicing(out: Voicing[], seen: Set<string>, v: Voicing) {
  const key = voicingKey(v);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(v);
}

function generatedVoicingCandidates(name: string, limit = 8): Voicing[] {
  const pcs = chordPitchClasses(name);
  if (pcs.length < 2) return [];
  const tones = [...new Set(pcs)];
  // per-string options: for each chord tone, the lowest fret (0..MAX_FRET)
  // on that string that sounds it; plus the "mute" option (null).
  const options: Voicing[] = OPEN_PC.map((open) => {
    const opts: Voicing = [];
    for (const t of tones) {
      const fret = (((t - open) % 12) + 12) % 12;
      if (fret <= MAX_FRET) opts.push(fret);
    }
    opts.push(null); // allow muting this string
    return opts;
  });

  const candidates: { v: Voicing; score: number }[] = [];
  const pick: Voicing = [null, null, null, null];
  const dfs = (s: number) => {
    if (s === 4) {
      const sounded = pick.filter((f): f is number => f !== null);
      if (!sounded.length) return;
      const covered = new Set(
        pick.map((f, i) => (f === null ? -1 : (OPEN_PC[i] + f) % 12)).filter((x) => x >= 0)
      );
      for (const t of tones) if (!covered.has(t)) return; // require full coverage
      // prefer: more strings sounding, then lower fret span, then lower frets
      const fretted = sounded.filter((f) => f > 0);
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      const score =
        sounded.length * 100 - span * 8 - (fretted.reduce((a, b) => a + b, 0) / Math.max(1, fretted.length));
      candidates.push({ v: pick.slice(), score });
      return;
    }
    for (const o of options[s]) {
      pick[s] = o;
      dfs(s + 1);
    }
    pick[s] = null;
  };
  dfs(0);
  candidates.sort((a, b) => b.score - a.score);
  const out: Voicing[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    addUniqueVoicing(out, seen, c.v);
    if (out.length >= limit) break;
  }
  return out;
}

// Voicings are pure given the normalized chord name, but the render loop asks
// for them every frame (via chordShapeState -> setShapeControls). Cache the
// result so the DFS voicing search runs once per chord name, not per frame.
const voicingCache = new Map<string, Voicing[]>();

function voicingsForChord(name: string): Voicing[] {
  const norm = normalizeChord(name);
  if (!norm) return [];
  const cached = voicingCache.get(norm);
  if (cached) return cached;
  const out: Voicing[] = [];
  const seen = new Set<string>();
  const verified = VOICINGS[norm];
  if (verified) addUniqueVoicing(out, seen, verified);
  for (const v of generatedVoicingCandidates(norm, 10)) addUniqueVoicing(out, seen, v);
  voicingCache.set(norm, out);
  return out;
}

const shapeChoice = new Map<string, number>();

function positiveMod(n: number, d: number): number {
  return ((n % d) + d) % d;
}

function chordShapeState(name: string): {
  norm: string;
  voicing: Voicing | null;
  index: number;
  count: number;
} {
  const norm = normalizeChord(name);
  const variants = voicingsForChord(norm);
  if (!norm || !variants.length) return { norm, voicing: null, index: 0, count: 0 };
  const raw = shapeChoice.get(norm) ?? 0;
  const index = positiveMod(raw, variants.length);
  if (index !== raw) shapeChoice.set(norm, index);
  return { norm, voicing: variants[index], index, count: variants.length };
}

function shapeLabel(state: { index: number; count: number }): string {
  return state.count > 0 ? `${state.index + 1}/${state.count}` : "0/0";
}

function shapeTag(name: string, state: { index: number; count: number }, extra = ""): string {
  if (!name) return "baritone";
  const shape = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
  return `${name}${extra} · ${shape}`;
}

function setShapeControls(
  name: string,
  controls: HTMLElement,
  countEl: HTMLElement,
  prevBtn: HTMLButtonElement,
  nextBtn: HTMLButtonElement
) {
  const state = chordShapeState(name);
  const canCycle = state.count > 1;
  controls.hidden = !canCycle;
  countEl.textContent = shapeLabel(state);
  prevBtn.disabled = !canCycle;
  nextBtn.disabled = !canCycle;
}

function invalidateFretboards() {
  lastCurrentFretChord = "__none__";
  lastNextFretChord = "__none__";
  lastTransitionKey = "__none__";
}

function redrawArrangementChordCards() {
  arrangementChordCards.forEach((card, name) => {
    const svg = card.querySelector(".arr-mini-fret");
    const shape = card.querySelector(".arr-card-shape");
    if (!svg || !shape) return;
    const state = chordShapeState(name);
    shape.textContent = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
    card.querySelectorAll<HTMLButtonElement>(".arr-shape-btn").forEach((btn) => {
      btn.disabled = state.count <= 1;
    });
    drawFretboard(
      name,
      false,
      "Up Next",
      {
        svg,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });
}

function cycleChordShape(name: string, delta: number) {
  const norm = normalizeChord(name);
  const variants = voicingsForChord(norm);
  if (!norm || variants.length <= 1) return;
  shapeChoice.set(norm, positiveMod((shapeChoice.get(norm) ?? 0) + delta, variants.length));
  invalidateFretboards();
  redrawArrangementChordCards();
  updateTransitionCoach(true);
}

// Draw baritone chord diagrams. The right rail shows two shapes at once:
// current target ("Now") and the next distinct shape ("Up Next").
let lastCurrentFretChord = "__none__";
let lastNextFretChord = "__none__";
let lastTransitionKey = "__none__";

function currentFretboardChord(detected: string, matched: boolean): { name: string; played: boolean } {
  return { name: targetChord || detected, played: matched };
}

function nextFretboardChord(): { name: string; played: boolean; isNext: boolean } {
  if (loadedSong && targetChord) {
    const next = nextDistinctChordInfo();
    if (next.name) {
      return { name: next.name, played: false, isNext: true };
    }
    return { name: "", played: false, isNext: false };
  }
  return { name: "", played: false, isNext: true };
}

currentShapePrevBtn.addEventListener("click", () => {
  cycleChordShape(currentFretboardChord(chord?.detected ?? "", false).name, -1);
});
currentShapeNextBtn.addEventListener("click", () => {
  cycleChordShape(currentFretboardChord(chord?.detected ?? "", false).name, 1);
});
nextShapePrevBtn.addEventListener("click", () => {
  cycleChordShape(nextFretboardChord().name, -1);
});
nextShapeNextBtn.addEventListener("click", () => {
  cycleChordShape(nextFretboardChord().name, 1);
});

function formatBeatDistance(beats: number): string {
  if (!Number.isFinite(beats)) return "";
  if (beats < 0.1) return "now";
  if (beats < 1) return "under 1 beat";
  return `${beats.toFixed(beats < 3 ? 1 : 0)} beats`;
}

function updateFretboardPanelState(matched: boolean) {
  const next = nextDistinctChordInfo();
  const currentName = currentFretboardChord(chord?.detected ?? "", matched).name;
  const nextGlow = next.name ? Math.max(0.12, Math.min(1, next.urgency)) : 0;
  currentFingerPanelEl.classList.toggle("is-clean", matched);
  nextFingerPanelEl.classList.toggle("has-upcoming", !!next.name);
  nextFingerPanelEl.classList.toggle("is-close", nextGlow > 0.68);
  currentFingerPanelEl.style.setProperty("--now-glow", loadedSong ? "1" : chordListening ? "0.62" : "0.35");
  nextFingerPanelEl.style.setProperty("--next-glow", nextGlow.toFixed(2));
  setShapeControls(currentName, currentShapeControlsEl, currentShapeCountEl, currentShapePrevBtn, currentShapeNextBtn);
  setShapeControls(next.name, nextShapeControlsEl, nextShapeCountEl, nextShapePrevBtn, nextShapeNextBtn);
  if (next.name) {
    const eta = timed ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
    fingerTagEl.textContent = shapeTag(next.name, chordShapeState(next.name), eta);
  }
  updateTransitionCoach();
}

function fretChip(fret: number | null): string {
  if (fret === null) return "x";
  return fret === 0 ? "0" : String(fret);
}

function fretHint(fret: number | null): string {
  if (fret === null) return "mute";
  return fret === 0 ? "open" : `fret ${fret}`;
}

function updateTransitionCoach(force = false) {
  const nowName = currentFretboardChord(chord?.detected ?? "", false).name;
  const next = nextDistinctChordInfo();
  const nextName = next.name;
  const nowState = chordShapeState(nowName);
  const nextState = chordShapeState(nextName);
  const eta = timed && nextName ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
  const key = `${nowName}|${nowState.index}|${nextName}|${nextState.index}|${songIdx}|${eta}`;
  if (!force && key === lastTransitionKey) return;
  lastTransitionKey = key;

  if (!nowName || !nextName || !nowState.voicing || !nextState.voicing) {
    transitionTagEl.textContent = loadedSong ? "last chord" : "free play";
    transitionCoachEl.innerHTML = loadedSong
      ? `<div class="transition-empty">Stay on ${escapeHtml(nowName || "the chord")}.</div>`
      : `<div class="transition-empty">Load a song to see the next move.</div>`;
    return;
  }

  transitionTagEl.textContent = `${nowName} -> ${nextName}${eta}`;
  const actions = STRING_LABELS.map((label, i) => {
    const from = nowState.voicing![i];
    const to = nextState.voicing![i];
    let kind = "move";
    let hint = `to ${fretHint(to)}`;
    if (from === to) {
      kind = "anchor";
      hint = from === null ? "muted" : "hold";
    } else if (to === null) {
      kind = "lift";
      hint = "mute";
    } else if (from === null) {
      kind = "add";
      hint = `add ${fretHint(to)}`;
    }
    return { label, from, to, kind, hint };
  });

  const anchors = actions.filter((a) => a.kind === "anchor" && a.to !== null).length;
  const changes = actions.filter((a) => a.kind !== "anchor").length;
  const headline = changes
    ? `${changes} move${changes === 1 ? "" : "s"} · ${anchors} anchor${anchors === 1 ? "" : "s"}`
    : "same shape";
  const rows = actions
    .map(
      (a) => `
        <div class="transition-string ${a.kind}">
          <span class="transition-string-name">${escapeHtml(a.label)}</span>
          <span class="transition-fret from">${fretChip(a.from)}</span>
          <span class="transition-arrow">&rarr;</span>
          <span class="transition-fret to">${fretChip(a.to)}</span>
          <span class="transition-hint">${escapeHtml(a.hint)}</span>
        </div>`
    )
    .join("");

  transitionCoachEl.innerHTML = `
    <div class="transition-summary">${escapeHtml(headline)}</div>
    <div class="transition-strings">${rows}</div>`;
}

function drawFretboard(
  name: string,
  played: boolean,
  label: "Now" | "Up Next",
  els: { svg: Element; title: Element; tag: Element },
  lastKey: string
): string {
  const state = chordShapeState(name);
  const key = `${label}|${name}|${played}|${state.index}|${state.count}|${state.voicing ? voicingKey(state.voicing) : "none"}`;
  if (key === lastKey) return lastKey;

  // verified shape first; fall back to a generated one for chords not in the
  // hand-checked table (so MIDI-derived exotics still get a diagram)
  const voicing = state.voicing;
  const accent = played ? "#19e3c4" : "#f5c451";
  const glow = played ? "rgba(25,227,196,0.6)" : "rgba(245,196,81,0.5)";
  const dim = "#2b4440";

  // geometry: 4 strings (cols), 4 frets (rows)
  const nS = 4,
    nF = 4;
  const x0 = 28,
    y0 = 40,
    w = 94,
    h = 120;
  const dx = w / (nS - 1);
  const dy = h / nF;

  els.title.textContent = label;
  if (!voicing) {
    els.svg.innerHTML = `<text x="75" y="105" fill="${dim}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">no diagram</text>`;
    els.tag.textContent = name ? `${name} · baritone` : "baritone";
    return key;
  }
  els.tag.textContent = shapeTag(name, state);

  // If the shape sits high on the neck, show a window of nF frets starting at
  // baseFret (with a position label) instead of always frets 0–4 from the nut.
  const fretted = voicing.filter((f): f is number => f !== null && f > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const baseFret = maxFret > nF ? Math.max(...fretted, 1) - (nF - 1) : 1;
  const openNut = baseFret === 1; // draw a thick nut only in open position

  const parts: string[] = [];
  // nut (thick at open position) or position label
  if (openNut) {
    parts.push(`<rect x="${x0 - 1}" y="${y0 - 4}" width="${w + 2}" height="4" fill="${dim}"/>`);
  } else {
    parts.push(`<text x="${x0 - 12}" y="${y0 + dy / 2 + 4}" fill="${accent}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">${baseFret}</text>`);
  }
  // fret lines
  for (let f = 0; f <= nF; f++) {
    const y = y0 + f * dy;
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${dim}" stroke-width="1"/>`);
  }
  // strings + labels + markers
  for (let s = 0; s < nS; s++) {
    const x = x0 + s * dx;
    parts.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + h}" stroke="${dim}" stroke-width="1.2"/>`);
    parts.push(`<text x="${x}" y="${y0 + h + 18}" fill="${dim}" font-size="11" font-family="Chakra Petch, sans-serif" text-anchor="middle">${STRING_LABELS[s]}</text>`);

    const fret = voicing[s];
    if (fret === null) {
      parts.push(`<text x="${x}" y="${y0 - 8}" fill="${accent}" font-size="12" font-family="JetBrains Mono, monospace" text-anchor="middle">×</text>`);
    } else if (fret === 0) {
      parts.push(`<circle cx="${x}" cy="${y0 - 12}" r="4.5" fill="none" stroke="${accent}" stroke-width="1.6"/>`);
    } else {
      const rel = fret - baseFret + 1; // 1-based row within the visible window
      const y = y0 + (rel - 0.5) * dy;
      parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${accent}" style="filter:drop-shadow(0 0 6px ${glow})"/>`);
    }
  }
  els.svg.innerHTML = parts.join("");
  return key;
}

// --- radial cleanliness gauge (square canvas, 270deg sweep, centered readout) ---
function drawGauge(value: number, active: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const rect = gauge.getBoundingClientRect();
  const w = rect.width || 240;
  const h = rect.height || 240;
  if (gauge.width !== Math.round(w * dpr) || gauge.height !== Math.round(h * dpr)) {
    gauge.width = Math.round(w * dpr);
    gauge.height = Math.round(h * dpr);
  }
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.38;
  const A0 = Math.PI * 0.75;
  const A1 = Math.PI * 2.25; // 270deg sweep from lower-left
  const v = Math.min(1, Math.max(0, value));

  // value color: teal when clean, gold/amber when not
  const clean = v >= 0.85;
  const color = !active ? "#3a5450" : clean ? "#19e3c4" : v >= 0.7 ? "#f5c451" : "#ff9d4d";

  // tick ring
  for (let i = 0; i <= 40; i++) {
    const a = A0 + (A1 - A0) * (i / 40);
    const major = i % 5 === 0;
    const r1 = R + 8;
    const r2 = R + (major ? 18 : 13);
    gctx.strokeStyle = `rgba(25,227,196,${major ? 0.32 : 0.13})`;
    gctx.lineWidth = major ? 1.4 : 1;
    gctx.beginPath();
    gctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    gctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    gctx.stroke();
  }

  // background track
  gctx.lineCap = "round";
  gctx.lineWidth = 12;
  gctx.strokeStyle = "rgba(25,227,196,0.10)";
  gctx.beginPath();
  gctx.arc(cx, cy, R, A0, A1);
  gctx.stroke();

  // value arc
  const a = A0 + (A1 - A0) * v;
  gctx.strokeStyle = color;
  gctx.shadowColor = color;
  gctx.shadowBlur = active ? 20 : 0;
  gctx.beginPath();
  gctx.arc(cx, cy, R, A0, a);
  gctx.stroke();
  gctx.shadowBlur = 0;

  // moving tip dot
  if (active) {
    const tx = cx + Math.cos(a) * R;
    const ty = cy + Math.sin(a) * R;
    gctx.fillStyle = "#fff";
    gctx.shadowColor = color;
    gctx.shadowBlur = 14;
    gctx.beginPath();
    gctx.arc(tx, ty, 4.5, 0, Math.PI * 2);
    gctx.fill();
    gctx.shadowBlur = 0;
  }

  // 85% threshold mark
  const ah = A0 + (A1 - A0) * 0.85;
  gctx.strokeStyle = "rgba(245,196,81,0.45)";
  gctx.lineWidth = 1.5;
  gctx.beginPath();
  gctx.moveTo(cx + Math.cos(ah) * (R - 8), cy + Math.sin(ah) * (R - 8));
  gctx.lineTo(cx + Math.cos(ah) * (R + 6), cy + Math.sin(ah) * (R + 6));
  gctx.stroke();

  // push color into readout
  cleanValEl.style.color = color;
  cleanValEl.style.textShadow = `0 0 18px ${color}99, 0 0 40px ${color}4d`;
  cleanStatusEl.style.color = color;
  cleanStatusEl.style.textShadow = `0 0 10px ${color}99`;
}

// --- full-width live FFT spectrum (real 96-bin log-spaced `spectrum` array) ---
function drawFFT() {
  const dpr = window.devicePixelRatio || 1;
  const rect = fft.getBoundingClientRect();
  const w = rect.width || 600;
  const h = rect.height || 150;
  if (fft.width !== Math.round(w * dpr) || fft.height !== Math.round(h * dpr)) {
    fft.width = Math.round(w * dpr);
    fft.height = Math.round(h * dpr);
  }
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.clearRect(0, 0, w, h);

  const padL = 6;
  const padR = 6;
  const padB = 18;
  const padT = 6;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // baseline
  fctx.strokeStyle = "rgba(25,227,196,0.14)";
  fctx.lineWidth = 1;
  fctx.beginPath();
  fctx.moveTo(padL, h - padB);
  fctx.lineTo(w - padR, h - padB);
  fctx.stroke();

  // log frequency gridlines + labels
  const ticks = [80, 147, 196, 294, 440, 659, 1000, 2000];
  fctx.font = '10px "JetBrains Mono", monospace';
  fctx.textAlign = "center";
  for (const fr of ticks) {
    const x = padL + logF(fr) * plotW;
    fctx.strokeStyle = "rgba(25,227,196,0.06)";
    fctx.beginPath();
    fctx.moveTo(x, padT);
    fctx.lineTo(x, h - padB);
    fctx.stroke();
    fctx.fillStyle = "rgba(25,227,196,0.4)";
    fctx.fillText(fr >= 1000 ? `${fr / 1000}k` : `${fr}`, x, h - 5);
  }

  // bins are log-spaced across F_MIN..F_MAX, so plot evenly across the log axis
  const xAt = (i: number) => padL + (i / (FFT_BINS - 1)) * plotW;
  const yAt = (i: number) => h - padB - Math.min(1, smoothSpec[i]) * plotH;

  // bins whose pitch class is a chord tone glow gold (catches harmonics too,
  // since a chord tone's octaves share its pitch class)
  const isGold = (i: number) => {
    if (!fftGoldPCs.length) return false;
    const pc = ((Math.round(69 + 12 * Math.log2(binF[i] / 440)) % 12) + 12) % 12;
    return fftGoldPCs.includes(pc);
  };

  // area fill under the curve
  fctx.beginPath();
  fctx.moveTo(padL, h - padB);
  for (let i = 0; i < FFT_BINS; i++) fctx.lineTo(xAt(i), yAt(i));
  fctx.lineTo(w - padR, h - padB);
  fctx.closePath();
  const grad = fctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, "rgba(25,227,196,0.22)");
  grad.addColorStop(1, "rgba(25,227,196,0.02)");
  fctx.fillStyle = grad;
  fctx.fill();

  // glowing line, per-segment teal/gold; brighter where the peak is tall
  fctx.lineWidth = 1.7;
  fctx.lineJoin = "round";
  for (let i = 0; i < FFT_BINS - 1; i++) {
    const gold = isGold(i) || isGold(i + 1);
    const tall = smoothSpec[i] > 0.22 || smoothSpec[i + 1] > 0.22;
    fctx.strokeStyle = gold
      ? `rgba(245,196,81,${tall ? 0.98 : 0.62})`
      : `rgba(25,227,196,${tall ? 0.92 : 0.5})`;
    fctx.shadowColor = gold ? "rgba(245,196,81,0.9)" : "rgba(25,227,196,0.8)";
    fctx.shadowBlur = (gold ? 11 : 7) * (tall ? 1.4 : 0.7);
    fctx.beginPath();
    fctx.moveTo(xAt(i), yAt(i));
    fctx.lineTo(xAt(i + 1), yAt(i + 1));
    fctx.stroke();
  }
  fctx.shadowBlur = 0;

  // labeled peak markers: find the strongest local maxima and name them
  const peaks: { i: number; v: number }[] = [];
  for (let i = 2; i < FFT_BINS - 2; i++) {
    if (
      smoothSpec[i] > 0.18 &&
      smoothSpec[i] >= smoothSpec[i - 1] &&
      smoothSpec[i] > smoothSpec[i + 1]
    ) {
      peaks.push({ i, v: smoothSpec[i] });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  fctx.textAlign = "center";
  fctx.font = '600 11px "JetBrains Mono", monospace';
  const top = peaks.slice(0, 4);
  for (const p of top) {
    const f = binF[p.i];
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    const pc = ((midi % 12) + 12) % 12;
    const name = PITCH_CLASSES[pc] + (Math.floor(midi / 12) - 1);
    const gold = fftGoldPCs.includes(pc);
    const col = gold ? "245,196,81" : "25,227,196";
    const x = xAt(p.i);
    const y = yAt(p.i);
    fctx.fillStyle = `rgba(${col},1)`;
    fctx.shadowColor = `rgba(${col},0.9)`;
    fctx.shadowBlur = 10;
    fctx.beginPath();
    fctx.arc(x, y, 3, 0, Math.PI * 2);
    fctx.fill();
    fctx.shadowBlur = 0;
    fctx.fillStyle = `rgba(${col},0.95)`;
    fctx.fillText(`${name} ${Math.round(f)}Hz`, x, Math.max(padT + 11, y - 9));
  }
  updatePeaksList(top);
}

// mirror the FFT's strongest peaks into the right-column analyzer list
let lastPeaksKey = "";
function updatePeaksList(peaks: { i: number; v: number }[]) {
  mPeakCountEl.textContent = String(peaks.length);
  const key = peaks.map((p) => p.i).join(",");
  if (key === lastPeaksKey) return; // avoid rebuilding the DOM every frame
  lastPeaksKey = key;
  if (!peaks.length) {
    peaksListEl.innerHTML = "";
    return;
  }
  let html = "";
  for (const p of peaks) {
    const f = binF[p.i];
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    const pc = ((midi % 12) + 12) % 12;
    const name = PITCH_CLASSES[pc] + (Math.floor(midi / 12) - 1);
    const gold = fftGoldPCs.includes(pc);
    const role = gold ? "chord tone" : "harmonic / other";
    html += `<div class="peak-row"><span class="dot ${gold ? "t" : "h"}"></span><span class="pn">${name}</span><span>${role}</span><span class="pf">${Math.round(f)} Hz</span></div>`;
  }
  peaksListEl.innerHTML = html;
}

requestAnimationFrame(renderChords);
