import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { addSong, listSongs, deleteSong, getSong, renameSong, type SongRecord } from "./library";
import type { Song } from "./song";

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
type AppMode = "tuner" | "play" | "cal-mic" | "library";

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
      await invoke("start_tuner");
      listening = true;
      listenBtn.textContent = "Stop listening";
      listenBtn.classList.add("on");
      setConn(false);
    } catch (e) {
      verdictEl.textContent = `mic error: ${e}`;
    }
  } else {
    await invoke("stop_tuner");
    listening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    setConn(false);
  }
});

// --- receive readings from Rust ---
listen<TunerReading>("tuner", (event) => {
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
const setupView = document.getElementById("setup-view")!;
const libraryView = document.getElementById("library-view")!;
const cornerLabel = document.getElementById("corner-label")!;
// any element with data-mode navigates (util buttons + back buttons)
const modeBtns = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

const chordNameEl = document.getElementById("chord-name")!;
const cleanValEl = document.getElementById("clean-val")!;
const cleanStatusEl = document.getElementById("clean-status")!;
const cleanTargetEl = document.getElementById("clean-target")!;
const coachEl = document.getElementById("coach")!;
const listenBtn2 = document.getElementById("listen-btn-2") as HTMLButtonElement;
const gauge = document.getElementById("gauge") as HTMLCanvasElement;
const gctx = gauge.getContext("2d")!;
const chromaEl = document.getElementById("chroma")!;
const fft = document.getElementById("fft") as HTMLCanvasElement;
const fctx = fft.getContext("2d")!;
const fretboardEl = document.getElementById("fretboard")!;
const fingerTagEl = document.getElementById("finger-tag")!;

// Verified baritone (D-G-B-E) voicings: fret per string [D, G, B, E];
// null = string not played. Every shape is checked to produce the correct
// chord tones (see the generator in the prototype). Covers all 12 majors,
// minors, plus common 7ths/maj7s/m7s.
const VOICINGS: Record<string, (number | null)[]> = {
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
    if (m !== "tuner" && m !== "play" && m !== "cal-mic" && m !== "library") return;
    if (m === mode) return;
    // stop any capture when changing screens
    await invoke("stop_audio").catch(() => {});
    listening = false;
    chordListening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);

    mode = m;
    tunerView.hidden = m !== "tuner";
    playView.hidden = m !== "play";
    setupView.hidden = m !== "cal-mic";
    libraryView.hidden = m !== "library";
    if (m === "library") renderSongList();
    cornerLabel.textContent =
      m === "tuner" ? "ukejam / Tuner · native"
      : m === "cal-mic" ? "ukejam / Setup · native"
      : m === "library" ? "ukejam / Library · native"
      : "ukejam / Chords · native";
  });
});

listenBtn2.addEventListener("click", async () => {
  if (!chordListening) {
    try {
      await invoke("start_chords");
      await invoke("set_target", { chord: targetChord || null });
      chordListening = true;
      listenBtn2.textContent = "Stop listening";
      listenBtn2.classList.add("on");
      setConn(false);
    } catch (e) {
      coachEl.textContent = `mic error: ${e}`;
    }
  } else {
    await invoke("stop_audio");
    chordListening = false;
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);
  }
});

// =====================================================================
// Library + loaded song (chord strip in Play, auto-advance)
// =====================================================================
const pasteBox = document.getElementById("paste-box") as HTMLTextAreaElement;
const songTitleInput = document.getElementById("song-title") as HTMLInputElement;
const songArtistInput = document.getElementById("song-artist") as HTMLInputElement;
const addSongBtn = document.getElementById("add-song-btn") as HTMLButtonElement;
const aiEnhanceToggle = document.getElementById("ai-enhance") as HTMLInputElement;
const libAddStatus = document.getElementById("lib-add-status")!;
const songListEl = document.getElementById("song-list")!;
const libCountEl = document.getElementById("lib-count")!;
const songBarEmpty = document.getElementById("song-bar-empty")!;
const songStrip = document.getElementById("song-strip")!;
const lyricsView = document.getElementById("lyrics-view")!;

// loaded song state
let loadedSong: Song | null = null;
let songIdx = 0; // index into chordSequence = current target chord
let stripChordEls: HTMLElement[] = [];
let advanceHold = 0; // frames the correct chord has been held (debounce)
// per-global-chord-index lyric token elements + the line each belongs to.
// Built in loadSongIntoPlay so songIdx -> {token, line} is O(1).
let lyricTokenEls: (HTMLElement | null)[] = [];
let lyricLineOfIdx: HTMLElement[] = [];

function setTarget(chord: string) {
  targetChord = chord;
  invoke("set_target", { chord: chord || null }).catch(() => {});
}

addSongBtn.addEventListener("click", async () => {
  const text = pasteBox.value.trim();
  if (!text) {
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "paste a tab first";
    return;
  }

  let source = text;
  if (aiEnhanceToggle.checked) {
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ enhancing with AI…";
    try {
      const cleaned = await invoke<string>("enhance_tab", { raw: text });
      if (cleaned && cleaned.trim()) source = cleaned.trim();
    } catch (e) {
      // fall back to the raw paste if the proxy isn't reachable
      libAddStatus.textContent = `AI enhance failed (${e}) — saved raw`;
    } finally {
      addSongBtn.disabled = false;
    }
  }

  const rec = addSong(source, {
    title: songTitleInput.value,
    artist: songArtistInput.value,
  });
  if (!libAddStatus.textContent?.includes("failed")) {
    libAddStatus.classList.add("done");
    libAddStatus.textContent = `added "${rec.title}"${rec.artist ? " — " + rec.artist : ""}`;
  }
  pasteBox.value = "";
  songTitleInput.value = "";
  songArtistInput.value = "";
  renderSongList();
});

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
  songIdx = 0;
  buildSongStrip();
  buildLyrics();
  setTarget(song.chordSequence[0]);
  // jump to Play
  (document.querySelector('[data-mode="play"]') as HTMLButtonElement)?.click();
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

// advance to the next chord when the current one is played cleanly
function maybeAdvance(reading: ChordReading) {
  if (!loadedSong || !targetChord) return;
  const hit = reading.active && reading.missing.length === 0 && reading.extra.length <= 1;
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

listen<ChordReading>("chord", (event) => {
  chord = event.payload;
  lastChordAt = performance.now();
  setConn(true);
  noteRms(event.payload.rms);
  maybeAdvance(event.payload);
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
    await invoke("start_tuner"); // any capture mode emits rms
    await new Promise((r) => setTimeout(r, 2000));
    await invoke("stop_audio");
    // robust noise floor: 90th percentile of measured silence
    let gate = 0.012;
    if (calibSamples.length) {
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1];
      gate = Math.max(0.006, floor * 4); // gate = noise floor x4
    }
    await invoke("set_gate", { gate });
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

function renderChords() {
  const now = performance.now();
  if (chordListening && now - lastChordAt > 300) {
    chord = { active: false, detected: "", cleanliness: 0, chroma: new Array(12).fill(0), spectrum: new Array(FFT_BINS).fill(0), missing: [], extra: [], rms: 0 };
    if (now - lastChordAt > 1500) setConn(false);
  }

  const c = chord;
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
    chordNameEl.textContent = c.detected || "—";
    chordNameEl.className = "chord-name " + (clean ? "clean" : "dirty");
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    cleanValEl.innerHTML = `${pct}<span class="pct">%</span>`;
    cleanStatusEl.textContent = clean ? "clean" : pct >= 70 ? "almost" : "off";
    cleanTargetEl.textContent = targetChord ? `target · ${targetChord}` : "free play";

    // coach text from missing/extra
    if (!targetChord) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">free play</span> · detecting`;
    } else if (c.missing.length === 0 && c.extra.length <= 1) {
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

    // fingering: show the target shape if set (what to play), else the
    // detected chord. Glows teal when the mic matches the shown chord.
    const shown = targetChord || c.detected;
    drawFretboard(shown, targetChord ? c.detected === targetChord : !!c.detected);
  } else {
    chordNameEl.textContent = "—";
    chordNameEl.className = "chord-name";
    smoothClean += (0 - smoothClean) * 0.15;
    cleanValEl.innerHTML = `0<span class="pct">%</span>`;
    cleanStatusEl.textContent = chordListening ? "listening…" : "idle";
    cleanTargetEl.textContent = targetChord ? `target · ${targetChord}` : "free play";
    coachEl.className = "coach good";
    coachEl.textContent = chordListening ? "play a chord" : "press start to listen";
    for (let i = 0; i < 12; i++) {
      chromaFills[i].style.height = "4%";
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }
    // flat FFT when idle
    for (let i = 0; i < FFT_BINS; i++) smoothSpec[i] += (0 - smoothSpec[i]) * 0.2;
    // show the target shape (what to play) while idle, else clear
    drawFretboard(targetChord, false);
  }

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

// Draw a baritone chord diagram into the SVG. `played` flags whether the
// shown chord is what the mic currently hears (glows teal) vs. just a target.
let lastFretChord = "__none__";
let lastFretPlayed = false;
function drawFretboard(name: string, played: boolean) {
  if (name === lastFretChord && played === lastFretPlayed) return;
  lastFretChord = name;
  lastFretPlayed = played;

  const voicing = VOICINGS[normalizeChord(name)];
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

  if (!voicing) {
    fretboardEl.innerHTML = `<text x="75" y="105" fill="${dim}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">no diagram</text>`;
    fingerTagEl.textContent = "baritone";
    return;
  }
  fingerTagEl.textContent = `${name} · baritone`;

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
  fretboardEl.innerHTML = parts.join("");
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
  for (const p of peaks.slice(0, 4)) {
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
}

requestAnimationFrame(renderChords);
