import {
  nativeInvoke,
  nativeListen,
  nativeRuntime,
  type BackingStatus,
  type ChordReading,
  type TunerReading,
} from "./native";
import { addSong, listSongs, deleteSong, getSong, renameSong, libraryReady, LibraryFullError, type SongRecord } from "./library";
import type { Song, SongLine } from "./song";
import {
  AI_PROVIDERS,
  aiConfigProblem,
  appleAvailabilityHint,
  hydrateAiConfig,
  invokeAiConfig,
  loadAiConfig,
  saveAiConfig,
  type AiProviderId,
} from "./ai";
import {
  buildOpenRouterAuthorizeUrl,
  buildOpenRouterLoginUrl,
  cleanOpenRouterCallbackUrl,
  cleanOpenRouterStrandUrl,
  createCodeVerifier,
  exchangeOpenRouterCodeInBrowser,
  isOpenRouterCallback,
  isOpenRouterCodeReturn,
  isOpenRouterStrand,
  openRouterCallbackUrl,
  openRouterCodeFromCallback,
  OPENROUTER_CALLBACK_PARAM,
} from "./openrouter";
import { authorizeInSystemBrowser, SystemAuthCancelled, SystemAuthUnavailable } from "./webAuth";
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
import {
  VerdictBuffer,
  accumulate,
  newAccumulator,
  seal,
  timingLabel,
  type BarAccumulator,
  type BarVerdict,
} from "./verdict";
import { StrumCam, type MotionSample, type Stroke, type StrumCall } from "./strumcam";
import { TUNINGS, type TuningId, type TuningSpec } from "./tunings";
import { barOfBeat, beatsPerBarOf, buildBeatTimeline, fmtTime, isTimedSong } from "./time";
import { PITCH_CLASSES, chordPitchClasses, pcNameToIndex } from "./theory/chords";
import {
  chordShapeState,
  cycleShapeChoice,
  resetVoicingsForTuningChange,
  shapeLabel,
  voicingKey,
} from "./theory/voicings";

type AppMode = "tuner" | "play" | "arrangement" | "cal-mic" | "library" | "strumcam";

// Standard is the default: it's what most ukuleles are. Replaced by the saved
// setting during startup (see applyTuning), before the user can play anything.
let tuning: TuningSpec = TUNINGS.standard;

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

// --- build per-string rows (rebuilt when the tuning changes) ---
const stringRows = new Map<string, HTMLElement>();
function buildStringRows() {
  stringsEl.textContent = "";
  stringRows.clear();
  for (const s of tuning.strings) {
    const row = document.createElement("div");
    row.className = "string-row";
    row.innerHTML = `
      <span class="string-note">${s.note[0]}</span>
      <span class="string-meta">${s.note} · ${s.hz.toFixed(1)} Hz</span>
      <span class="string-check">○</span>`;
    stringsEl.appendChild(row);
    stringRows.set(s.note, row);
  }
}
buildStringRows();

// --- listen toggle ---
listenBtn.addEventListener("click", async () => {
  if (!listening) {
    try {
      await nativeInvoke("start_tuner");
      listening = true;
      listenBtn.textContent = "Stop listening";
      listenBtn.classList.add("on");
      setConn(false);
      syncKeepAwake();
    } catch (e) {
      verdictEl.textContent = `mic error: ${e}`;
    }
  } else {
    await nativeInvoke("stop_tuner");
    listening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    setConn(false);
    syncKeepAwake();
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

// --- keep the screen awake while the app is actually in use ---
// On iOS the idle timer would lock the screen mid-song: you play for minutes
// without touching the glass. Anything that changes `listening`,
// `chordListening` or `playing` calls this, and the native side is only poked
// when the combined state flips (setIdleTimerDisabled is a main-thread hop).
let keepAwake = false;
function syncKeepAwake() {
  const want = listening || chordListening || playing;
  if (want === keepAwake) return;
  keepAwake = want;
  nativeInvoke("set_keep_awake", { awake: want }).catch(() => {});
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
const strumcamView = document.getElementById("strumcam-view")!;
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
const coachTagEl = document.getElementById("coach-tag")!;
const coachAdviceEl = document.getElementById("coach-advice")!;
// analyzer panel (right column)
const mMatchEl = document.getElementById("m-match")!;
const mfMatchEl = document.getElementById("mf-match") as HTMLElement;
const mPeakCountEl = document.getElementById("m-peakcount")!;
const mFluxEl = document.getElementById("m-flux")!;
const mOnsetEl = document.getElementById("m-onset")!;
const peaksListEl = document.getElementById("peaks-list")!;
const arrangementTagEl = document.getElementById("arrangement-tag")!;
const arrangementNowEl = document.getElementById("arr-now")!;
const arrangementNextEl = document.getElementById("arr-next")!;
const arrangementCountEl = document.getElementById("arr-count")!;
const arrangementEmptyEl = document.getElementById("arrangement-empty")!;
const arrangementSheetEl = document.getElementById("arrangement-sheet")!;
const arrangementChordsEl = document.getElementById("arrangement-chords")!;
const arrangementChordTagEl = document.getElementById("arrangement-chord-tag")!;



let mode: AppMode = "play";
let chordListening = false;
let chord: ChordReading | null = null;
let lastChordAt = 0;
// When the last attack was seen, so the diagnostics lamp can stay lit long
// enough to perceive — an onset is true for one reading only.
let lastOnsetAt = 0;
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
    if (m !== "tuner" && m !== "play" && m !== "arrangement" && m !== "cal-mic" && m !== "library" && m !== "strumcam") return;
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
      syncKeepAwake();
    }
    if (fromPractice && !toPractice) {
      stopTransport();
      nativeInvoke("stop_backing").catch(() => {});
    }

    if (mode === "strumcam" && m !== "strumcam") stopStrumcamSession();

    mode = m;
    tunerView.hidden = m !== "tuner";
    playView.hidden = m !== "play";
    arrangementView.hidden = m !== "arrangement";
    setupView.hidden = m !== "cal-mic";
    libraryView.hidden = m !== "library";
    strumcamView.hidden = m !== "strumcam";
    // highlight the active utility button (Play has no util button → none lit)
    modeBtns.forEach((b) => b.classList.toggle("active", !!b.dataset.mode && b.dataset.mode === m));
    if (m === "library") renderSongList();
    if (m === "arrangement") updateArrangementState(true);
    cornerLabel.textContent =
      m === "tuner" ? "ukejam / Tuner · native"
      : m === "arrangement" ? "ukejam / Arrangement · native"
      : m === "cal-mic" ? "ukejam / Setup · native"
      : m === "library" ? "ukejam / Library · native"
      : m === "strumcam" ? "ukejam / StrumCam · native"
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
      syncKeepAwake();
    } catch (e) {
      coachEl.textContent = `mic error: ${e}`;
    }
  } else {
    await nativeInvoke("stop_audio");
    chordListening = false;
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);
    syncKeepAwake();
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
// How many bars the highway keeps tinted behind the NOW line.
const VERDICT_TRAIL_BARS = 3;

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

// Whether the detector could actually parse the current target. False for a
// chord name neither side understands (a typo, or a quality we don't support):
// Rust then holds no target, so `missing`/`extra` come back empty, which looks
// exactly like a flawless chord. Everything that grades must check this first.
let targetGradeable = false;

function setTarget(chord: string) {
  targetChord = chord;
  // Assume ungradeable until Rust confirms it parsed. Optimistic-then-correct
  // would flash a false "Locked in" for a frame on every chord change.
  targetGradeable = false;
  nativeInvoke<boolean>("set_target", { chord: chord || null })
    .then((ok) => {
      // Ignore a stale reply: the player may have moved on while it was in flight.
      if (targetChord === chord) targetGradeable = ok && !!chord;
      updatePracticeUi();
    })
    .catch(() => {
      // The call itself failed (no native runtime, or a transient IPC error), so
      // Rust never told us either way. Fall back to our own resolver, which
      // shares its vocabulary: a real chord stays gradeable rather than grading
      // switching itself off silently for the rest of the session.
      if (targetChord === chord) targetGradeable = chordPitchClasses(chord).length > 0;
      updatePracticeUi();
    });
  updatePracticeUi();
}

function isCleanHit(reading: ChordReading | null): boolean {
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
  // Rolling score over the last 16 bars: enough history to mean something,
  // short enough that fixing a rough patch shows up while you're still on it.
  const score = verdicts.hitCount(16);
  const scoreText = score.total ? ` · ${score.hits}/${score.total} bars` : "";
  // Rhythm alongside the chord score, because they fail independently: a player
  // can hold every chord perfectly and still strum once where the bar wants four.
  const rhythmText = timed ? verdicts.rhythmSummary(16) : "";

  songTagEl.textContent = artist ? `${title} · ${artist}` : title;
  practiceTitleEl.textContent = artist ? `${title} — ${artist}` : title;
  practiceSubEl.textContent =
    (timed ? `${modeText} · ${micText} · ${backingText}` : `${modeText} · ${micText}`) +
    scoreText + rhythmText;
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
  // The saved provider config is read from the native store asynchronously at
  // boot; a song added before that lands would otherwise be enhanced with the
  // seeded default rather than what the player configured.
  if (aiEnhanceToggle.checked) await aiConfigReady;
  // A provider that can't run (no key, Apple Intelligence unavailable) skips
  // the AI step with a pointer to Setup instead of failing a doomed request.
  const aiProblem = aiEnhanceToggle.checked ? aiEnhanceProblem() : null;
  // When the AI step is skipped, its explanation must survive the generic
  // "added …" status written after the save.
  let aiSkipNote = false;
  if (mode === "fuse" && aiEnhanceToggle.checked && !aiProblem) {
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
        config: invokeAiConfig(aiConfig),
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
    aiSkipNote = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = aiProblem
      ? `${aiProblem} — open ⚙ Setup · saved chart only`
      : "lyrics need ✨ AI enhance to merge — saved chart only";
  } else if (aiEnhanceToggle.checked && aiProblem) {
    aiSkipNote = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = `${aiProblem} — open ⚙ Setup · saved raw`;
  } else if (aiEnhanceToggle.checked) {
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ enhancing with AI…";
    try {
      const cleaned = await nativeInvoke<string>("enhance_tab", {
        raw: text,
        mode,
        lyrics: null,
        config: invokeAiConfig(aiConfig),
      });
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
  if (!aiSkipNote && !libAddStatus.textContent?.includes("failed")) {
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

// =====================================================================
// In-app tab search — find a chord sheet online (Rust scrapes Ultimate
// Guitar), preview it in an in-app WebKit window, and pull the text into
// the paste box so it flows through the normal ✨ enhance → Add pipeline.
// =====================================================================
interface TabHit {
  artist: string;
  song: string;
  url: string;
  kind: string;
  rating: number;
  votes: number;
  version: number;
}
interface TabSearchOutcome {
  queries: string[];
  hits: TabHit[];
}
interface TabContent {
  title: string;
  artist: string;
  text: string;
  url: string;
}

const tabSearchInput = document.getElementById("tab-search-input") as HTMLInputElement;
const tabSearchBtn = document.getElementById("tab-search-btn") as HTMLButtonElement;
const smartSearchToggle = document.getElementById("smart-search") as HTMLInputElement;
const tabResultsEl = document.getElementById("tab-results")!;
const tabSearchStatus = document.getElementById("tab-search-status")!;

let tabSearching = false;

function setTabSearchStatus(text: string, done = false) {
  tabSearchStatus.hidden = !text;
  tabSearchStatus.textContent = text;
  tabSearchStatus.classList.toggle("done", done);
}

async function runTabSearch() {
  const q = tabSearchInput.value.trim();
  if (!q || tabSearching) return;
  tabSearching = true;
  tabSearchBtn.disabled = true;
  tabResultsEl.hidden = true;
  tabResultsEl.replaceChildren();
  setTabSearchStatus(smartSearchToggle.checked ? "✨ working out what to search…" : "searching…");
  try {
    // smart mode goes through the configured AI provider — wait for the
    // durable settings so a saved key/model is actually used
    if (smartSearchToggle.checked) await aiConfigReady;
    const out = await nativeInvoke<TabSearchOutcome>("search_tabs", {
      query: q,
      smart: smartSearchToggle.checked,
      config: smartSearchToggle.checked ? invokeAiConfig(aiConfig) : null,
    });
    renderTabResults(q, out);
  } catch (e) {
    setTabSearchStatus(`search failed: ${e}`);
  } finally {
    tabSearching = false;
    tabSearchBtn.disabled = false;
  }
}

function renderTabResults(rawQuery: string, out: TabSearchOutcome) {
  if (out.hits.length === 0) {
    setTabSearchStatus("no chord tabs found — try adding the artist, or ✨ smart");
    return;
  }
  // when smart mode rewrote the query, show what was actually searched
  const rewrote = out.queries.length > 1 || out.queries[0] !== rawQuery;
  const searched = rewrote ? ` · searched: ${out.queries.join(" / ")}` : "";
  setTabSearchStatus(`${out.hits.length} chord tabs${searched}`, true);

  for (const hit of out.hits) {
    const row = document.createElement("div");
    row.className = "tab-hit";
    row.title = "Load this tab into the paste box";

    const song = document.createElement("span");
    song.className = "t-song";
    song.textContent = hit.song;
    const artist = document.createElement("span");
    artist.className = "t-artist";
    artist.textContent = hit.artist;
    const meta = document.createElement("span");
    meta.className = "t-meta";
    const stars = hit.votes ? ` · ★${hit.rating.toFixed(1)} (${hit.votes})` : "";
    meta.textContent = `${hit.kind.toLowerCase()}${stars} · v${hit.version}`;
    const open = document.createElement("button");
    open.className = "t-open";
    open.textContent = "view ↗";
    open.title = "Open the tab page in an in-app preview window";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      nativeInvoke("open_tab_page", { url: hit.url }).catch((err) =>
        setTabSearchStatus(`couldn't open preview: ${err}`)
      );
    });

    row.append(song, artist, meta, open);
    row.addEventListener("click", () => useTabHit(hit));
    tabResultsEl.appendChild(row);
  }
  tabResultsEl.hidden = false;
}

// Pull a chosen tab's text into the add-a-song form. Deliberately does NOT
// auto-add: the user reviews (and can ✨ enhance) exactly like a manual paste.
async function useTabHit(hit: TabHit) {
  setTabSearchStatus(`⇣ fetching ${hit.song}…`);
  try {
    const tab = await nativeInvoke<TabContent>("fetch_tab", { url: hit.url });
    clearMidiStaging(); // fetched text replaces any staged MIDI chart
    pasteBox.value = tab.text;
    songTitleInput.value = tab.title || hit.song;
    songArtistInput.value = tab.artist || hit.artist;
    setTabSearchStatus(`loaded "${tab.title || hit.song}" — review below, then Add to library`, true);
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "";
  } catch (e) {
    setTabSearchStatus(`couldn't fetch that tab: ${e}`);
  }
}

tabSearchBtn.addEventListener("click", runTabSearch);
tabSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runTabSearch();
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
  // Drop the outgoing song's score BEFORE swapping loadedSong: setupTiming()
  // below calls stopTransport(), which would otherwise coach the old song's bars
  // against the new song's tempo and chord names.
  resetScoring();
  // Advice about the previous song is worse than none. Not folded into
  // resetScoring(), which also runs on a loop — where the advice the player just
  // read is still about the part they're replaying.
  resetCoaching();
  loadedSong = song;
  loadedRecord = rec;
  songIdx = 0;
  buildSectionMap(song); // before setupTiming: a sealed bar reads this
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
  resetScoring();
  timed = isTimedSong(song);
  chordBeat = [];
  if (!timed) {
    transportEl.hidden = true;
    arrTransportEl.hidden = true;
    songBeats = 0;
    // Untimed songs score per chord advance, and sealUntimedChord files the
    // chord we're leaving — so open the first one here or chord 0 is never
    // graded (resetScoring left currentBar at -1, meaning "nothing open").
    currentBar = 0;
    currentBarChordIdx = 0;
    updatePracticeUi();
    return;
  }
  secPerBeat = 60 / song.tempo;
  beatsPerBar = beatsPerBarOf(song);
  const timeline = buildBeatTimeline(song, beatsPerBar);
  chordBeat = timeline.chordBeat;
  songBeats = timeline.songBeats;
  tpBpmEl.textContent = `${Math.round(song.tempo)} bpm`;
  arrBpmEl.textContent = `${Math.round(song.tempo)} bpm`;
  tpTimeEl.textContent = "0:00";
  arrTimeEl.textContent = "0:00";
  transportEl.hidden = false;
  arrTransportEl.hidden = false;
  setPlayBtn(false);
  updatePracticeUi();
}

// --- per-bar scoring ---

// Map every chord index to the section it sits in, so a verdict can say "the
// bridge falls apart" rather than just "bar 34". Sections come from {comment:}
// directives, which a lot of songs simply don't have — an empty label is normal.
function buildSectionMap(song: Song) {
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

function resetScoring() {
  verdicts.clear();
  barAccum = newAccumulator();
  currentBar = -1;
  currentBarChordIdx = 0;
  currentBarStartedAt = null;
  currentBarWaited = false;
  // This counts bars in the buffer we just emptied, so it has to go with it —
  // otherwise it stays ahead of verdicts.length and the sectionless trigger
  // stops firing for a whole extra window.
  coachBarsAtLastRequest = 0;
}

// Close out the bar the accumulator has been filling and file its verdict.
// `nextBar`/`nextChordIdx` open the following bar in the same step, so the
// downbeat timestamp used for the timing offset is the one we actually crossed.
function sealCurrentBar(nextBar: number, nextChordIdx: number, at: number | null) {
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
  if (sealed) onVerdictSealed(sealed);
}

// Untimed songs have no bar clock, so a "bar" is one chord: seal when the player
// advances. There is no downbeat to measure against, hence no timing claims.
function sealUntimedChord(chordIdx: number) {
  if (timed) return;
  sealCurrentBar(chordIdx, chordIdx, null);
}

// --- LLM coaching ---
// Everything above this line is local and instant. This part asks the model for
// the one thing the app can't compute: the pattern across bars. It fires on its
// own, so the guards below matter as much as the call — an eager coach that
// interrupts every few seconds is worse than no coach.

const COACH_WINDOW_BARS = 16; // how many graded bars the model sees
const COACH_MIN_BARS = 4; // below this there's no pattern to find
const COACH_COOLDOWN_MS = 20_000; // floor between calls, whatever triggered them
const COACH_ROUGH_WINDOW = 8; // bars the rough-patch check looks at
const COACH_ROUGH_RATE = 0.5; // hit rate below which the player is struggling
const COACH_SECTIONLESS_BARS = 16; // fallback cadence when a song has no sections

let coachInFlight = false;
let coachLastAt = 0;
let coachLastSection = "";
let coachBarsAtLastRequest = 0;
// Shown once per session, not per failure: a player without an endpoint
// configured would otherwise get the same error at every section boundary.
let coachEndpointWarned = false;

/// Ask for advice on the bars just played. Called from several triggers, all of
/// which can fire close together, so this is the single place the guards live.
function requestCoaching(reason: string) {
  if (!nativeRuntime || !loadedSong || coachInFlight) return;
  if (verdicts.length < COACH_MIN_BARS) return;
  const now = performance.now();
  if (coachLastAt && now - coachLastAt < COACH_COOLDOWN_MS) return;

  const window = verdicts.recent(COACH_WINDOW_BARS);
  // Nothing sounded at all: the player is holding the instrument, not playing
  // it. Coaching silence produces advice about a performance that didn't happen.
  if (window.every((v) => v.status === "MISS")) return;

  const digest = verdicts.digest(COACH_WINDOW_BARS, {
    tempo: timed ? loadedSong.tempo : 0,
    timeSig: loadedSong.timeSig ?? [4, 4],
  });
  if (!digest) return;

  coachInFlight = true;
  coachLastAt = now;
  coachBarsAtLastRequest = verdicts.length;
  renderCoachThinking(reason);
  // Same provider as tab enhancement — whatever is configured in Setup.
  nativeInvoke<string>("coach_bars", {
    digest,
    reason,
    config: invokeAiConfig(aiConfig),
  })
    .then((text) => renderCoachAdvice(text))
    .catch((e) => renderCoachError(e))
    .finally(() => {
      coachInFlight = false;
    });
}

/// Called after each bar is graded: the automatic triggers that depend on how
/// the playing is going, rather than on a transport event.
function onVerdictSealed(v: BarVerdict) {
  if (!loadedSong) return;

  // Section boundary — the natural unit of "how did that bit go". Songs without
  // {comment:} markers get a fixed cadence instead.
  if (v.section) {
    if (coachLastSection && v.section !== coachLastSection) {
      requestCoaching(`finished the ${coachLastSection}`);
    }
    coachLastSection = v.section;
  } else if (verdicts.length - coachBarsAtLastRequest >= COACH_SECTIONLESS_BARS) {
    requestCoaching(`${COACH_SECTIONLESS_BARS} bars in`);
  }

  // Rough patch — coaching arrives while the player is still in the trouble,
  // which is the only time it can actually help.
  const rate = verdicts.hitRate(COACH_ROUGH_WINDOW);
  if (
    rate !== null &&
    rate < COACH_ROUGH_RATE &&
    verdicts.length >= COACH_ROUGH_WINDOW
  ) {
    requestCoaching("struggling with this part");
  }
}

function renderCoachThinking(reason: string) {
  coachTagEl.textContent = reason;
  coachAdviceEl.innerHTML = `<span class="coach-thinking">thinking…</span>`;
}

/// Render the model's lines. Per SYSTEM_COACH it returns at most three short
/// sentences, fixes first and the encouraging one last, so the final line gets
/// the green rule. Anything longer is truncated rather than allowed to overflow
/// the panel — the prompt asks for three lines but can't be relied on for it.
function renderCoachAdvice(text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!lines.length) {
    coachAdviceEl.innerHTML = `<span class="coach-idle">Nothing to add — keep going.</span>`;
    return;
  }
  coachAdviceEl.innerHTML = lines
    .map((l, i) => {
      const good = lines.length > 1 && i === lines.length - 1;
      return `<div class="coach-line${good ? " good" : ""}">${escapeHtml(l)}</div>`;
    })
    .join("");
}

/// A failed coaching call must never interrupt practice. The most likely cause by
/// far is no configured provider, so say that once and then stay quiet.
function renderCoachError(e: unknown) {
  if (coachEndpointWarned) {
    coachAdviceEl.innerHTML = `<span class="coach-idle">Play a few bars and I'll tell you what to work on.</span>`;
    coachTagEl.textContent = "across bars";
    return;
  }
  coachEndpointWarned = true;
  console.warn("coaching unavailable", e);
  coachTagEl.textContent = "unavailable";
  coachAdviceEl.innerHTML =
    `<span class="coach-note">Coaching needs an AI provider — pick one on the Setup screen. ` +
    `Bar-by-bar scoring keeps working without it.</span>`;
}

function resetCoaching() {
  coachLastSection = "";
  coachBarsAtLastRequest = 0;
  coachTagEl.textContent = "across bars";
  coachAdviceEl.innerHTML =
    `<span class="coach-idle">Play a few bars and I'll tell you what to work on.</span>`;
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
  syncKeepAwake();
  if (hasBacking) playBacking();
}

function stopTransport() {
  const wasPlaying = playing;
  playing = false;
  waiting = false;
  setPlayBtn(false);
  syncKeepAwake();
  if (hasBacking) nativeInvoke("pause_backing").catch(() => {});
  // Stopping is when the player wants to know how that went. The buffer is left
  // intact so pressing play again continues the same run. Gated on wasPlaying
  // because setupTiming() calls this on every song load — coaching the player
  // about the song they just navigated away from would be nonsense.
  if (wasPlaying) requestCoaching("paused");
}

function restartTransport() {
  songTime = 0;
  songIdx = 0;
  waiting = false;
  resetScoring(); // a fresh run from the top is a fresh score
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
// Also the single place bars are closed out: both the wall-clock tick and the
// backing-audio sync funnel through here, so scoring can't miss a bar or
// double-count one depending on which clock is driving the playhead.
function applyBeat(beat: number) {
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
    // A full pass through the song is the natural moment for a review, and the
    // buffer is about to be rewound — so ask before clearing it.
    requestCoaching("song end");
    songTime = 0;
    songIdx = 0;
    resetScoring();
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
    currentBarWaited = true; // suppresses this bar's timing offset (see sealCurrentBar)
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
  // The backing engine owns looping, so a position that jumps backwards is the
  // song wrapping. Review the pass and start a fresh score, mirroring what the
  // wall-clock path does at `beat >= songBeats`.
  if (pos + 0.5 < songTime) {
    requestCoaching("song end");
    resetScoring();
  }
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
    // Verdict tint persists for the whole run, so the strip doubles as a map of
    // where the song went wrong — the highway trail only shows the last few bars.
    const v = verdicts.forChordIdx(i);
    el.classList.toggle("hit", v?.status === "HIT");
    el.classList.toggle("wrong", v?.status === "WRONG");
    el.classList.toggle("miss", v?.status === "MISS");
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
    arrangementChordTagEl.textContent = tuning.spelling;
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
    const state = chordShapeState(ch, tuning);
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
  // Verdict colours for the trail behind NOW. Green/amber/grey reads at a glance
  // without needing the legend a fourth colour would. These mirror
  // --verdict-hit/-wrong/-miss in styles.css, which tint the same bars on the
  // song strip; canvas needs the components separately for rgba(), hence the
  // duplication.
  const HIT = "76,222,128"; // --verdict-hit  #4cde80
  const WRONG = "245,158,66"; // --verdict-wrong #f59e42
  const MISS = "120,132,146"; // --verdict-miss  #788492

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

  // How far behind NOW the graded trail extends, in beats.
  const trailBeats = timed ? VERDICT_TRAIL_BARS * beatsPerBar : VERDICT_TRAIL_BARS;

  // draw upcoming tokens from nearest-future back, mapping beat-distance to y.
  // Bars the playhead has already crossed stay on screen for a few beats, tinted
  // by their verdict — the player sees how the last bars went without looking
  // away from where they're going.
  for (let i = 0; i < seq.length; i++) {
    const tb = timed ? chordBeat[i] : i;
    const rel = tb - headBeat; // beats ahead of the playhead (0 = at NOW)
    if (rel > LOOKAHEAD_BEATS) break; // too far ahead
    const passed = rel < -0.6;
    const verdict = passed ? verdicts.forChordIdx(i) : undefined;
    if (passed && (!verdict || rel < -trailBeats)) continue; // off the trail
    if (passed) {
      drawTrailToken(hctx, cx, nowY, verdict!, -rel / trailBeats, seq[i], { HIT, WRONG, MISS });
      continue;
    }
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

// A bar the playhead has passed, drawn below the NOW line and tinted by its
// verdict. `fade` runs 0 (just passed) -> 1 (leaving the trail); the token
// shrinks and dims as it goes so it never competes with what's coming.
//
// The timing arrow is the point of the whole onset detector: ▲ = you strummed
// early, ▼ = late. Only drawn past TIMING_TOLERANCE_MS, since below that the
// number is mostly detector latency rather than the player.
function drawTrailToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  nowY: number,
  v: BarVerdict,
  fade: number,
  label: string,
  cols: { HIT: string; WRONG: string; MISS: string }
) {
  const f = Math.max(0, Math.min(1, fade));
  const col = v.status === "HIT" ? cols.HIT : v.status === "WRONG" ? cols.WRONG : cols.MISS;
  const y = nowY + 20 + f * 26;
  const scale = 0.72 - f * 0.22;
  const alpha = 0.85 * (1 - f);
  const tw = 56 * scale;
  const th = 26 * scale;
  ctx.globalAlpha = alpha;
  roundRect(ctx, cx - tw / 2, y - th / 2, tw, th, 7 * scale);
  ctx.strokeStyle = `rgba(${col},0.7)`;
  ctx.lineWidth = 1.2 * scale;
  ctx.stroke();
  ctx.fillStyle = `rgba(${col},0.1)`;
  ctx.fill();
  ctx.fillStyle = `rgba(${col},0.95)`;
  ctx.font = `700 ${Math.round(16 * scale)}px "Chakra Petch", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + 1);

  const timing = timingLabel(v.offsetMs);
  if (timing) {
    ctx.font = `700 ${Math.round(13 * scale)}px "Chakra Petch", sans-serif`;
    ctx.fillText(timing === "early" ? "▲" : "▼", cx + tw / 2 + 9 * scale, y + 1);
  }

  // Strum dots, left of the token: one per strum ACTUALLY PLAYED, filled when it
  // landed on the rhythmic grid (beat or half-beat) and hollow when it drifted.
  //
  // Deliberately not one dot per beat with the misses hollow: that would tell a
  // player strumming sensible half notes they missed two beats, when the app has no
  // idea what pattern the song wants (the Song model has no pattern field). And no
  // early/late marker, because on a half-beat grid "130ms late for the beat" and
  // "120ms early for the off-beat" are the same event. What can be shown honestly
  // is how many times you strummed and how many were in time.
  if (v.rhythm && v.rhythm.strums) {
    const r = v.rhythm;
    const shown = Math.min(r.strums, 8); // a very busy bar would otherwise sprawl
    const dot = 2.2 * scale;
    const step = dot * 2.8;
    const x0 = cx - tw / 2 - 10 * scale - (shown - 1) * step;
    for (let i = 0; i < shown; i++) {
      ctx.beginPath();
      ctx.arc(x0 + i * step, y + 1, dot, 0, Math.PI * 2);
      if (i < Math.min(r.onBeat, shown)) {
        ctx.fillStyle = `rgba(${col},0.9)`;
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(${col},0.45)`;
        ctx.lineWidth = 1 * scale;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
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
      sealUntimedChord(songIdx);
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
  // Fold this window into the bar being scored. Gated on the transport being
  // engaged so noodling with the song paused isn't graded — but NOT on `waiting`:
  // wait-for-me parks the playhead mid-bar precisely so the player can find the
  // chord, and that strum is the one the bar should be scored on. (Its timing
  // offset is meaningless in wait mode, which is the point of the mode.)
  // The mic now also runs under the StrumCam view; only the practice surfaces
  // grade bars or advance the song, so noodling in the lab can't touch a score.
  const practicing = mode === "play" || mode === "arrangement";
  if (practicing && loadedSong && (!timed || playing)) {
    accumulate(barAccum, event.payload, lastChordAt);
  }
  if (event.payload.onset) {
    lastOnsetAt = lastChordAt;
    strumcamOnset(lastChordAt);
  }
  if (practicing) maybeAdvance(event.payload);
});

// backing-track playback position from Rust drives the highway playhead
nativeListen<BackingStatus>("backing", (event) => {
  if (event.payload.playing) syncBackingPos(event.payload.pos);
});

// ---- iOS audio-session interruptions and route changes ----
// A phone call, Siri, or another app taking the session kills our streams and
// iOS does not hand them back. The native observer re-activates the session and
// tells us; only the frontend knows what the user was doing, so resuming is our
// job. Nothing fires on desktop.
//
// Playback does NOT auto-resume: having a backing track burst out of the
// speaker the instant you hang up is worse than pressing play yourself. The
// transport pauses and the mic — passive — comes back on its own.
let wasListeningBeforeInterruption = false;
let wasChordListeningBeforeInterruption = false;

nativeListen<{ began: boolean }>("audio_interruption", async (event) => {
  if (event.payload.began) {
    wasListeningBeforeInterruption = listening;
    wasChordListeningBeforeInterruption = chordListening;
    // The streams are already dead; drop our own state so the buttons and the
    // "live" dot don't lie, and pause the transport so we don't silently run
    // the playhead past the whole song while the audio is gone.
    listening = false;
    chordListening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);
    if (playing) stopTransport();
    await nativeInvoke("stop_audio").catch(() => {});
    syncKeepAwake();
    coachEl.textContent = "audio interrupted — resuming when the call ends";
    updatePracticeUi();
    return;
  }

  // Interruption over: the native side has re-activated the session, so put
  // the mic back exactly where it was.
  try {
    if (wasChordListeningBeforeInterruption) {
      await nativeInvoke("start_chords");
      await nativeInvoke("set_target", { chord: targetChord || null });
      chordListening = true;
      listenBtn2.textContent = "Stop listening";
      listenBtn2.classList.add("on");
    } else if (wasListeningBeforeInterruption) {
      await nativeInvoke("start_tuner");
      listening = true;
      listenBtn.textContent = "Stop listening";
      listenBtn.classList.add("on");
    }
    if (chordListening || listening) coachEl.textContent = "";
  } catch (e) {
    coachEl.textContent = `mic didn't come back: ${e} — press Start listening`;
  }
  wasListeningBeforeInterruption = false;
  wasChordListeningBeforeInterruption = false;
  setConn(false);
  syncKeepAwake();
  updatePracticeUi();
});

// Headphones pulled out (reason 2 = old device unavailable). Apple's guidance
// is to pause rather than blast the built-in speaker; the mic keeps going since
// the native side has already re-routed it.
nativeListen<{ reason: number }>("audio_route_change", (event) => {
  if (event.payload.reason !== 2) return;
  if (playing) {
    stopTransport();
    coachEl.textContent = "output device disconnected — playback paused";
  }
  updatePracticeUi();
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

// --- tuning (Setup screen) ---
// Persisted through Rust into app-data settings.json. `set_settings` merges, so
// writing `{tuning}` here cannot disturb the AI provider config that ai.ts owns.
const taglineEl = document.getElementById("tagline")!;
const tuningChoiceEl = document.getElementById("tuning-choice")!;
const tuningStatus = document.getElementById("tuning-status")!;

/// Switch tuning and refresh everything derived from it: the tuner's target
/// strings (native + the row list), every cached voicing, and the labels. Safe
/// to call while listening — the native side swaps on the next window.
function applyTuning(id: TuningId, persist: boolean) {
  tuning = TUNINGS[id];
  taglineEl.textContent = `${id === "baritone" ? "baritone" : "standard"} · ${tuning.spelling}`;
  tuningChoiceEl
    .querySelectorAll<HTMLInputElement>('input[name="tuning"]')
    .forEach((r) => (r.checked = r.value === id));

  buildStringRows();
  // Voicings and the chosen shape index are per-tuning; a G shape on a
  // baritone is a different list, so a stale index would point at nothing.
  resetVoicingsForTuningChange();
  invalidateFretboards();
  if (loadedSong) buildArrangement();
  updateArrangementState(true);

  nativeInvoke("set_tuning", { tuning: id }).catch(() => {});
  if (!persist) return;
  nativeInvoke("set_settings", { settings: { tuning: id } })
    .then(() => {
      tuningStatus.classList.add("done");
      tuningStatus.textContent = `saved — tuning to ${tuning.spelling}`;
    })
    .catch((e) => {
      tuningStatus.classList.remove("done");
      tuningStatus.textContent = `save failed: ${e}`;
    });
}

tuningChoiceEl.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.name !== "tuning") return;
  applyTuning(input.value === "baritone" ? "baritone" : "standard", true);
});

// Rust applies the saved tuning to the tuner at startup; this aligns the UI with
// it (and is a no-op re-send when the setting is absent/standard).
void nativeInvoke<{ tuning?: string }>("get_settings")
  .then((s) => applyTuning(s?.tuning === "baritone" ? "baritone" : "standard", false))
  .catch(() => {});
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

// --- AI enhance provider settings (Setup screen) ---
// Seeded synchronously from localStorage, then replaced by the durable native
// store (see ai.ts); the live object travels with every enhance/test invoke.
const aiConfig = loadAiConfig();
// Resolves once the durable store has been read. Anything that sends the
// config awaits this first, so an enhance fired seconds after launch can't go
// out with a stale seed (or, on a fresh install, an empty one).
const aiConfigReady: Promise<void> = hydrateAiConfig(aiConfig).then((loaded) => {
  if (loaded) renderAiPanel();
});
// On-device availability, probed async at boot. Anything but "available"
// greys out the Apple option with the reason.
let appleStatus = "unsupportedHost";

const aiProviderSel = document.getElementById("ai-provider") as HTMLSelectElement;
const aiNoteEl = document.getElementById("ai-note")!;
const aiBaseUrlField = document.getElementById("ai-baseurl-field")!;
const aiBaseUrlInput = document.getElementById("ai-base-url") as HTMLInputElement;
const aiKeyField = document.getElementById("ai-key-field")!;
const aiKeyInput = document.getElementById("ai-api-key") as HTMLInputElement;
const aiModelField = document.getElementById("ai-model-field")!;
const aiModelInput = document.getElementById("ai-model") as HTMLInputElement;
const aiModelList = document.getElementById("ai-model-list") as HTMLDataListElement;
const aiScanBtn = document.getElementById("ai-scan-btn") as HTMLButtonElement;
const aiTestBtn = document.getElementById("ai-test-btn") as HTMLButtonElement;
const aiStatusEl = document.getElementById("ai-status")!;
const aiOrActions = document.getElementById("ai-or-actions")!;
const aiOrLoginBtn = document.getElementById("ai-or-login") as HTMLButtonElement;
const aiOrDisconnectBtn = document.getElementById("ai-or-disconnect") as HTMLButtonElement;

function aiEnhanceProblem(): string | null {
  return aiConfigProblem(aiConfig, appleStatus);
}

function setAiStatus(text: string, tone: "" | "done" | "err" = "") {
  aiStatusEl.classList.remove("done", "err");
  if (tone) aiStatusEl.classList.add(tone);
  aiStatusEl.textContent = text;
}

const AI_PROVIDER_NOTES: Record<AiProviderId, string> = {
  apple:
    "Nothing leaves this device. The on-device model is small — long or messy tabs may come out better on a cloud model.",
  openrouter:
    'One account, every major model. Connect with one tap below, or create a key at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a> and paste it.',
  openai:
    "Works with OpenAI, LiteLLM, LM Studio, Ollama — anything speaking the OpenAI chat protocol. The API key is optional for keyless local servers.",
};

function renderAiStatusLine() {
  const problem = aiEnhanceProblem();
  if (problem) {
    setAiStatus(`${problem} — ✨ AI enhance will be skipped`);
  } else if (aiConfig.provider === "apple") {
    setAiStatus("ready — runs privately on this device", "done");
  } else {
    setAiStatus("configured — test the connection to be sure");
  }
}

// Full structural render: provider options (with availability verdicts), field
// visibility, and current values. Not called from input handlers — rewriting
// an input's value while the user types would throw the caret away.
function renderAiPanel() {
  aiProviderSel.replaceChildren();
  Object.values(AI_PROVIDERS).forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    if (provider.id === "apple" && appleStatus !== "available") {
      // Keep the option visible so players learn it exists, but grey it out
      // WITH the reason ("Apple devices only", "model still downloading", …) —
      // an unexplained disabled option reads as a bug.
      option.disabled = true;
      option.textContent += ` — ${appleAvailabilityHint(appleStatus)}`;
    }
    option.selected = provider.id === aiConfig.provider;
    aiProviderSel.append(option);
  });
  const provider = aiConfig.provider;
  aiBaseUrlField.hidden = provider !== "openai";
  aiKeyField.hidden = provider === "apple";
  aiModelField.hidden = provider === "apple";
  aiScanBtn.hidden = provider === "apple";
  updateOpenRouterButtons();
  aiBaseUrlInput.value = aiConfig.baseUrl || AI_PROVIDERS.openai.defaultBaseUrl;
  aiKeyInput.value = aiConfig.apiKey;
  aiModelInput.value = aiConfig.model;
  aiNoteEl.innerHTML = AI_PROVIDER_NOTES[provider];
  renderAiStatusLine();
}

aiProviderSel.addEventListener("change", () => {
  const provider = aiProviderSel.value as AiProviderId;
  aiConfig.provider = provider;
  aiConfig.model = AI_PROVIDERS[provider].defaultModel;
  if (provider === "openai" && !aiConfig.baseUrl.trim()) {
    aiConfig.baseUrl = AI_PROVIDERS.openai.defaultBaseUrl;
  }
  saveAiConfig(aiConfig);
  aiModelList.replaceChildren(); // a catalog scanned from another endpoint is stale
  renderAiPanel();
});
aiBaseUrlInput.addEventListener("input", () => {
  aiConfig.baseUrl = aiBaseUrlInput.value;
  saveAiConfig(aiConfig);
  renderAiStatusLine();
});
aiKeyInput.addEventListener("input", () => {
  aiConfig.apiKey = aiKeyInput.value;
  saveAiConfig(aiConfig);
  updateOpenRouterButtons();
  renderAiStatusLine();
});
aiModelInput.addEventListener("input", () => {
  aiConfig.model = aiModelInput.value;
  saveAiConfig(aiConfig);
  renderAiStatusLine();
});

// Fill the model datalist from the endpoint's own catalog (GET /models).
aiScanBtn.addEventListener("click", async () => {
  aiScanBtn.disabled = true;
  setAiStatus("scanning the endpoint's model catalog…");
  try {
    const models = await nativeInvoke<string[]>("ai_models", { config: invokeAiConfig(aiConfig) });
    aiModelList.replaceChildren(
      ...models.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      })
    );
    if (!aiConfig.model.trim() && models.length) {
      aiConfig.model = models[0];
      aiModelInput.value = models[0];
      saveAiConfig(aiConfig);
    }
    setAiStatus(
      models.length
        ? `found ${models.length} models — the Model field now autocompletes`
        : "the endpoint returned no models — enter a model id manually"
    );
  } catch (e) {
    setAiStatus(`model scan failed: ${e}`, "err");
  } finally {
    aiScanBtn.disabled = false;
  }
});

// A real chat round trip — the only probe that proves the key AND model work.
aiTestBtn.addEventListener("click", async () => {
  const problem = aiEnhanceProblem();
  if (problem) {
    setAiStatus(problem, "err");
    return;
  }
  aiTestBtn.disabled = true;
  setAiStatus(`testing ${aiConfig.provider === "apple" ? "the on-device model" : aiConfig.model.trim()}…`);
  try {
    const reply = await nativeInvoke<string>("test_ai", { config: invokeAiConfig(aiConfig) });
    setAiStatus(`connection works — replied “${reply}”`, "done");
  } catch (e) {
    setAiStatus(`${e}`, "err");
  } finally {
    aiTestBtn.disabled = false;
  }
});

async function probeAppleAvailability() {
  if (!nativeRuntime) return;
  try {
    const res = await nativeInvoke<{ status: string }>("plugin:local-llm|availability");
    appleStatus = res?.status ?? "unavailable";
  } catch {
    appleStatus = "unavailable";
  }
  renderAiPanel();
}

// --- OpenRouter one-tap sign-in (PKCE) ---
// The login navigates the whole webview to openrouter.ai and back, so this
// module reloads mid-flow: the verifier (and, after the return leg, the code)
// live in storage until the exchange finishes. Ported from Wormdrop.
const OPENROUTER_PKCE_STORAGE_KEY = "ukejam.openrouter.pkce.v1";
const OPENROUTER_PKCE_MAX_AGE_MS = 15 * 60 * 1000;

type PendingPkce = { verifier: string; createdAt?: number; code?: string };

function pendingOpenRouterRecord(): PendingPkce | null {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const raw = storage.getItem(OPENROUTER_PKCE_STORAGE_KEY);
      if (!raw) continue;
      const saved = JSON.parse(raw) as PendingPkce;
      if (saved?.verifier && Date.now() - Number(saved.createdAt) < OPENROUTER_PKCE_MAX_AGE_MS) {
        return saved;
      }
    } catch {
      // Try the other storage implementation.
    }
  }
  return null;
}

function pendingOpenRouterVerifier(): string {
  return pendingOpenRouterRecord()?.verifier ?? "";
}

// The one-shot auth code arrives in the URL, which the return leg cleans
// immediately — persist it next to the verifier so a webview crash between
// the return and the exchange can resume at next boot instead of eating the
// sign-in (field-hit in Wormdrop: WebContent died mid-boot).
function stampPendingOpenRouterCode(code: string | null) {
  const record = pendingOpenRouterRecord();
  if (!record?.verifier || !code) return;
  const pending = JSON.stringify({ ...record, code });
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(OPENROUTER_PKCE_STORAGE_KEY, pending);
    } catch {}
  }
}

function clearOpenRouterVerifier() {
  try {
    localStorage.removeItem(OPENROUTER_PKCE_STORAGE_KEY);
  } catch {}
  try {
    sessionStorage.removeItem(OPENROUTER_PKCE_STORAGE_KEY);
  } catch {}
}

function updateOpenRouterButtons() {
  const isOpenRouter = aiConfig.provider === "openrouter";
  const hasKey = Boolean(aiConfig.apiKey.trim());
  aiOrActions.hidden = !isOpenRouter;
  aiOrLoginBtn.hidden = hasKey;
  aiOrDisconnectBtn.hidden = !hasKey;
}

// Land the player on the Setup screen (where the OpenRouter card and its
// status line live) — used by every OAuth return path.
function openSetupView() {
  (document.querySelector('.util-btn[data-mode="cal-mic"]') as HTMLButtonElement | null)?.click();
}

// The verifier must survive the round-trip through openrouter.ai. If the
// browser blocks BOTH storages (private mode, storage denied), the return
// leg could never complete — report that here, before navigating away,
// instead of silently after sign-in.
function storeOpenRouterVerifier(verifier: string): boolean {
  const pending = JSON.stringify({ verifier, createdAt: Date.now() });
  let stored = false;
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(OPENROUTER_PKCE_STORAGE_KEY, pending);
      stored = true;
    } catch {
      // Try the other storage implementation.
    }
  }
  return stored;
}

// Sign in through the OS browser sheet (iOS: ASWebAuthenticationSession),
// where the player gets a Cancel button, Safari's existing openrouter.ai
// session, Keychain autofill and passkeys — none of which exist in the app's
// own webview. The app is never unloaded, so the fragile parts of the web
// flow (verifier round-trip, return-leg detection, crash resume) simply
// don't apply on this path.
//
// Returns false when there is no native sheet on this host, which is the
// signal to fall back to the in-page redirect below.
async function startNativeOpenRouterLogin(verifier: string): Promise<boolean> {
  try {
    const callbackUrl = await authorizeInSystemBrowser({
      authUrl: await buildOpenRouterAuthorizeUrl(verifier),
      callbackParam: OPENROUTER_CALLBACK_PARAM,
    });
    const code = openRouterCodeFromCallback(callbackUrl);
    if (!code) throw new Error("OpenRouter finished without returning a sign-in code");
    await finishOpenRouterExchange(code, verifier);
    return true;
  } catch (error) {
    if (error instanceof SystemAuthUnavailable) return false;
    clearOpenRouterVerifier();
    if (error instanceof SystemAuthCancelled) {
      setAiStatus("sign-in cancelled — tap Connect OpenRouter whenever you're ready");
    } else {
      setAiStatus(`${error} — please try connecting again`, "err");
    }
    return true;
  }
}

async function startOpenRouterLogin() {
  const verifier = createCodeVerifier();
  if (!storeOpenRouterVerifier(verifier)) {
    setAiStatus(
      "your browser is blocking site storage, so the secure sign-in can't complete — allow storage for this site and try again",
      "err"
    );
    return;
  }
  if (nativeRuntime) {
    aiOrLoginBtn.disabled = true;
    setAiStatus("opening the secure OpenRouter sign-in…");
    try {
      if (await startNativeOpenRouterLogin(verifier)) return;
    } finally {
      aiOrLoginBtn.disabled = false;
    }
  }
  // No native sheet here (browser build, dev server, desktop package): the
  // page navigates to openrouter.ai and comes back with ?code=…. In the
  // packaged app the callback is a localhost sentinel OpenRouter will accept
  // (its tauri:// origin would be rejected, stranding the player on
  // openrouter.ai); the Rust hook routes that redirect back here.
  const callback = openRouterCallbackUrl(window.location.href, nativeRuntime);
  try {
    window.location.assign(await buildOpenRouterLoginUrl(callback.toString(), verifier));
  } catch (e) {
    setAiStatus(`could not start the OpenRouter sign-in: ${e}`, "err");
  }
}

async function finishOpenRouterExchange(code: string, verifier: string) {
  setAiStatus("finishing secure sign-in…");
  try {
    const apiKey = nativeRuntime
      ? await nativeInvoke<string>("openrouter_exchange", { code, verifier })
      : await exchangeOpenRouterCodeInBrowser(code, verifier);
    aiConfig.provider = "openrouter";
    aiConfig.apiKey = apiKey;
    if (!aiConfig.model.trim()) aiConfig.model = AI_PROVIDERS.openrouter.defaultModel;
    saveAiConfig(aiConfig);
    renderAiPanel();
    setAiStatus("connected to OpenRouter — test the connection to be sure", "done");
  } catch (e) {
    setAiStatus(`${e} — please try connecting again`, "err");
  } finally {
    clearOpenRouterVerifier();
  }
}

// The Rust navigation hook re-entered the app because OpenRouter's login flow
// dumped the webview on its homepage instead of resuming /auth (its bot
// protection severs the redirect chain in embedded webviews). The sign-in
// itself succeeded and the session cookie survived, so a plain retry goes
// straight to the authorize screen.
function reportStrandedOpenRouterLogin() {
  const url = new URL(window.location.href);
  if (!isOpenRouterStrand(url)) return;
  window.history.replaceState({}, "", cleanOpenRouterStrandUrl(url));
  aiConfig.provider = "openrouter";
  saveAiConfig(aiConfig);
  renderAiPanel();
  openSetupView();
  setAiStatus(
    "OpenRouter signed you in but didn't return to the app — tap Connect OpenRouter again; you're signed in now, so it should go straight to the authorize screen",
    "err"
  );
}

async function completeOpenRouterLogin() {
  const url = new URL(window.location.href);
  const verifier = pendingOpenRouterVerifier();
  if (!isOpenRouterCallback(url) && !isOpenRouterCodeReturn(url, Boolean(verifier))) return;
  const code = url.searchParams.get("code");
  stampPendingOpenRouterCode(code);
  window.history.replaceState({}, "", cleanOpenRouterCallbackUrl(url));
  // Land back on the OpenRouter card whatever happens next — including the
  // failure paths, whose messages render there.
  aiConfig.provider = "openrouter";
  saveAiConfig(aiConfig);
  renderAiPanel();
  openSetupView();
  if (!verifier) {
    // The return leg arrived but the verifier is gone — expired (15-minute
    // limit) or dropped by the browser between the two legs. The code can't
    // be exchanged without it; say so instead of silently doing nothing.
    setAiStatus(
      "sign-in returned, but its secure verifier had expired or was lost — tap Connect OpenRouter to try again",
      "err"
    );
    return;
  }
  await finishOpenRouterExchange(code ?? "", verifier);
}

// A webview crash between the return leg and the key exchange reloads the
// page with a clean URL. The code was persisted next to the verifier, so
// finish the interrupted exchange instead of losing the sign-in.
async function resumeInterruptedOpenRouterLogin() {
  const url = new URL(window.location.href);
  if (isOpenRouterCallback(url) || isOpenRouterCodeReturn(url, Boolean(pendingOpenRouterVerifier()))) return;
  const pending = pendingOpenRouterRecord();
  if (!pending?.code || !pending?.verifier || aiConfig.apiKey.trim()) return;
  aiConfig.provider = "openrouter";
  saveAiConfig(aiConfig);
  renderAiPanel();
  openSetupView();
  await finishOpenRouterExchange(pending.code, pending.verifier);
}

aiOrLoginBtn.addEventListener("click", () => void startOpenRouterLogin());
aiOrDisconnectBtn.addEventListener("click", () => {
  aiConfig.apiKey = "";
  saveAiConfig(aiConfig);
  renderAiPanel();
});

renderAiPanel();
void probeAppleAvailability();
reportStrandedOpenRouterLogin();
void completeOpenRouterLogin();
void resumeInterruptedOpenRouterLogin();

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
  // Drop a reading the mic has stopped refreshing. NOT gated on chordListening:
  // when the stream stops, the last reading used to sit on screen indefinitely,
  // so the hero chord kept asserting a verdict about audio from minutes ago —
  // visible as a lit-up "Locked in" on a freshly loaded song with the mic idle.
  if (chord && now - lastChordAt > 300) {
    chord = null;
    if (chordListening && now - lastChordAt > 1500) setConn(false);
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
    // A target we can't parse gets no verdict at all — say so plainly instead of
    // reporting on a comparison that never happened.
    chordSubEl.textContent = !targetChord
      ? "Playing"
      : !targetGradeable
        ? `can't grade ${targetChord} — heard ${c.detected || "—"}`
        : matched
          ? "Locked in"
          : `heard ${c.detected || "—"}`;
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    cleanValEl.innerHTML = `${pct}<span class="pct">%</span>`;
    cleanStatusEl.textContent = clean ? "clean" : pct >= 70 ? "almost" : "off";
    cleanTargetEl.textContent = targetChord ? `target · ${targetChord}` : "free play";

    // coach text from missing/extra
    if (!targetChord) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">free play</span> · heard <b>${c.detected || "—"}</b>`;
    } else if (!targetGradeable) {
      coachEl.className = "coach";
      coachEl.innerHTML = `<span class="miss">can't grade <b>${targetChord}</b></span> — not a chord we know, so this bar isn't scored`;
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
    // onset detector: flux ratio plus a lamp held on for 140ms, since `onset` is
    // true for a single reading and would otherwise be invisible.
    mFluxEl.textContent = `${c.flux.toFixed(1)}x`;
    mOnsetEl.classList.toggle("lit", now - lastOnsetAt < 140);

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
    mFluxEl.textContent = "—";
    mOnsetEl.classList.remove("lit");
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




function shapeTag(name: string, state: { index: number; count: number }, extra = ""): string {
  if (!name) return tuning.spelling;
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
  const state = chordShapeState(name, tuning);
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
    const state = chordShapeState(name, tuning);
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
  if (!cycleShapeChoice(name, tuning, delta)) return;
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
    fingerTagEl.textContent = shapeTag(next.name, chordShapeState(next.name, tuning), eta);
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
  const nowState = chordShapeState(nowName, tuning);
  const nextState = chordShapeState(nextName, tuning);
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
  const actions = tuning.stringLabels.map((label, i) => {
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
  const state = chordShapeState(name, tuning);
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
    els.tag.textContent = name ? `${name} · ${tuning.spelling}` : tuning.spelling;
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
    parts.push(`<text x="${x}" y="${y0 + h + 18}" fill="${dim}" font-size="11" font-family="Chakra Petch, sans-serif" text-anchor="middle">${tuning.stringLabels[s]}</text>`);

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

// =====================================================================
// StrumCam — camera strum-direction lab
// =====================================================================
// The mic's onset detector says WHEN a strum happened; the camera says WHICH
// WAY the hand was moving at that instant (see strumcam.ts for why the split
// runs exactly along that line). This view is the in-app feasibility rig: it
// surfaces every call with its evidence and tallies outcomes, so whether the
// motion signal is good enough to feed practice feedback is measured, not
// assumed.
const scPreview = document.getElementById("sc-preview") as HTMLCanvasElement;
const scStrip = document.getElementById("sc-strip") as HTMLCanvasElement;
const scStartBtn = document.getElementById("sc-start") as HTMLButtonElement;
const scFlipEl = document.getElementById("sc-flip") as HTMLInputElement;
const scStatusEl = document.getElementById("sc-status")!;
const scGlyphEl = document.getElementById("sc-glyph")!;
const scCallsEl = document.getElementById("sc-calls")!;
const scCallsEmptyEl = document.getElementById("sc-calls-empty")!;
const scDownsEl = document.getElementById("sc-downs")!;
const scUpsEl = document.getElementById("sc-ups")!;
const scUnsureEl = document.getElementById("sc-unsure")!;
const scGhostsEl = document.getElementById("sc-ghosts")!;
const scFpsEl = document.getElementById("sc-fps")!;

const scTally = { downs: 0, ups: 0, unsure: 0, ghosts: 0 };
/// Onset markers for the strip chart; `call` lands ~160ms after the onset.
const scMarks: { t: number; call: StrumCall | null }[] = [];
/// Trace ring for the strip chart (the analyser keeps its own).
const scSamples: MotionSample[] = [];
let scMicOn = false;
let scRafId = 0;
let scStatusTimer: ReturnType<typeof setTimeout> | null = null;

const strumcam = new StrumCam({
  onSample: (s: MotionSample) => {
    scSamples.push(s);
    const cutoff = s.t - 6000;
    while (scSamples.length && scSamples[0].t < cutoff) scSamples.shift();
  },
  onCall: (call: StrumCall, onsetT: number) => scRecordCall(call, onsetT),
  onStroke: (stroke: Stroke, ghost: boolean) => {
    if (!ghost) return;
    scTally.ghosts++;
    scRenderTally();
    scFlashStatus(`ghost ${stroke.dir === "down" ? "▼" : "▲"} stroke — hand swept, no strum heard`);
  },
  onStatus: (msg: string) => {
    scStatusEl.textContent = msg;
  },
});
strumcam.attachPreview(scPreview);

scFlipEl.addEventListener("change", () => {
  strumcam.flip = scFlipEl.checked;
});

function strumcamOnset(t: number): void {
  if (mode !== "strumcam" || !strumcam.active) return;
  scMarks.push({ t, call: null });
  if (scMarks.length > 64) scMarks.shift();
  strumcam.noteOnset(t);
}

function scRenderTally(): void {
  scDownsEl.textContent = String(scTally.downs);
  scUpsEl.textContent = String(scTally.ups);
  scUnsureEl.textContent = String(scTally.unsure);
  scGhostsEl.textContent = String(scTally.ghosts);
}

function scFlashStatus(msg: string): void {
  scStatusEl.textContent = msg;
  if (scStatusTimer) clearTimeout(scStatusTimer);
  scStatusTimer = setTimeout(() => {
    if (strumcam.active) {
      scStatusEl.textContent =
        strumcam.backend === "hand" ? "camera live · hand model" : "camera live · motion fallback";
    }
  }, 1800);
}

function scRecordCall(call: StrumCall, onsetT: number): void {
  const mark = scMarks.find((m) => m.t === onsetT);
  if (mark) mark.call = call;
  if (call.dir === "down") scTally.downs++;
  else if (call.dir === "up") scTally.ups++;
  else scTally.unsure++;
  scRenderTally();

  const arrow = call.dir === "down" ? "▼" : call.dir === "up" ? "▲" : "?";
  scGlyphEl.textContent = arrow;
  // drop + re-add the animation class with a forced reflow between, so
  // back-to-back strums each get their own pop
  scGlyphEl.className = `sc-glyph ${call.dir === "unknown" ? "unsure" : call.dir}`;
  void (scGlyphEl as HTMLElement).offsetWidth;
  scGlyphEl.classList.add("pop");

  scCallsEmptyEl.hidden = true;
  const row = document.createElement("div");
  row.className = `sc-call ${call.dir === "unknown" ? "unsure" : call.dir}`;
  const label = call.dir === "unknown" ? (call.reason ?? "unsure") : `${call.dir}stroke`;
  const meta =
    call.samples === 0
      ? "no frames in window"
      : `${call.speed.toFixed(2)} h/s · ${Math.round(call.consistency * 100)}% agree · ${call.samples} fr`;
  row.innerHTML = `<span class="sc-call-arrow">${arrow}</span><span class="sc-call-label">${label}</span><span class="sc-call-meta">${meta}</span>`;
  scCallsEl.insertBefore(row, scCallsEl.firstChild);
  while (scCallsEl.querySelectorAll(".sc-call").length > 40) {
    scCallsEl.querySelector(".sc-call:last-of-type")?.remove();
  }
}

function scResetSession(): void {
  scTally.downs = scTally.ups = scTally.unsure = scTally.ghosts = 0;
  scMarks.length = 0;
  scSamples.length = 0;
  scRenderTally();
  scGlyphEl.textContent = "·";
  scGlyphEl.className = "sc-glyph";
  scCallsEl.querySelectorAll(".sc-call").forEach((el) => el.remove());
  scCallsEmptyEl.hidden = false;
}

async function startStrumcamSession(): Promise<void> {
  try {
    await strumcam.start();
  } catch (e) {
    scStatusEl.textContent = `camera error: ${e}`;
    return;
  }
  strumcam.flip = scFlipEl.checked;
  scResetSession();
  try {
    await nativeInvoke("start_chords");
    scMicOn = true;
    chordListening = true; // keeps the screen awake on iOS, like any mic use
    syncKeepAwake();
  } catch (e) {
    // The camera alone still shows strokes and ghosts; say why calls won't come.
    scStatusEl.textContent = `camera live, mic error: ${e} — no onsets, so no calls`;
  }
  scStartBtn.textContent = "Stop";
  scStartBtn.classList.add("on");
  scRafId = requestAnimationFrame(scDrawStrip);
}

function stopStrumcamSession(): void {
  if (strumcam.active) strumcam.stop();
  cancelAnimationFrame(scRafId);
  if (scMicOn) {
    scMicOn = false;
    chordListening = false;
    nativeInvoke("stop_audio").catch(() => {});
    syncKeepAwake();
  }
  scStartBtn.textContent = "Start camera + mic";
  scStartBtn.classList.remove("on");
}

scStartBtn.addEventListener("click", () => {
  if (strumcam.active) stopStrumcamSession();
  else void startStrumcamSession();
});

// --- strip chart: the last few seconds of vertical hand velocity, with each
// mic onset marked and annotated by the call it got. Down is drawn downward.
const SC_SPAN_MS = 5000;
const SC_VMAX = 3; // frame-heights/sec at the chart edge

function scDrawStrip(): void {
  if (!strumcam.active) return;
  scRafId = requestAnimationFrame(scDrawStrip);

  const dpr = window.devicePixelRatio || 1;
  const rect = scStrip.getBoundingClientRect();
  if (rect.width === 0) return;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (scStrip.width !== w || scStrip.height !== h) {
    scStrip.width = w;
    scStrip.height = h;
  }
  const ctx = scStrip.getContext("2d")!;
  const now = performance.now();
  const xAt = (t: number) => w - ((now - t) / SC_SPAN_MS) * w;
  const yAt = (v: number) => h / 2 + (Math.max(-SC_VMAX, Math.min(SC_VMAX, v)) / SC_VMAX) * (h / 2 - 6 * dpr);

  ctx.clearRect(0, 0, w, h);

  // axis + up/down legend (+v = down the frame = downstroke, drawn downward)
  ctx.strokeStyle = "rgba(207,232,230,0.14)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.font = `600 ${10 * dpr}px "JetBrains Mono", monospace`;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(207,232,230,0.3)";
  ctx.fillText("▲ up", 8 * dpr, 12 * dpr);
  ctx.fillText("▼ down", 8 * dpr, h - 6 * dpr);

  // velocity trace, broken wherever the camera saw stillness
  ctx.strokeStyle = "rgba(25,227,196,0.85)";
  ctx.lineWidth = 1.6 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  let prevT = 0;
  for (const s of scSamples) {
    if (s.t < now - SC_SPAN_MS) continue;
    const x = xAt(s.t);
    const y = yAt(s.v);
    if (!pen || s.t - prevT > 120) {
      ctx.moveTo(x, y);
      pen = true;
    } else {
      ctx.lineTo(x, y);
    }
    prevT = s.t;
  }
  ctx.stroke();

  // onset markers with their calls
  ctx.textAlign = "center";
  ctx.font = `700 ${12 * dpr}px "JetBrains Mono", monospace`;
  for (const m of scMarks) {
    if (m.t < now - SC_SPAN_MS) continue;
    const x = xAt(m.t);
    const pending = m.call === null;
    const dir = m.call?.dir;
    const col =
      pending ? "rgba(207,232,230,0.35)"
      : dir === "down" ? "rgba(25,227,196,0.95)"
      : dir === "up" ? "rgba(245,196,81,0.95)"
      : "rgba(120,132,146,0.9)";
    ctx.strokeStyle = col;
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(x, 14 * dpr);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.fillText(pending ? "●" : dir === "down" ? "▼" : dir === "up" ? "▲" : "?", x, 12 * dpr);
  }

  scFpsEl.textContent = strumcam.active ? String(strumcam.fps) : "—";
}
