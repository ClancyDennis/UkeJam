import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  missing: string[];
  extra: string[];
  rms: number;
}

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
type AppMode = "tuner" | "play";

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
const cornerLabel = document.getElementById("corner-label")!;
const modeBtns = document.querySelectorAll<HTMLButtonElement>(".mode-btn");

const chordNameEl = document.getElementById("chord-name")!;
const cleanValEl = document.getElementById("clean-val")!;
const cleanStatusEl = document.getElementById("clean-status")!;
const coachEl = document.getElementById("coach")!;
const targetSelect = document.getElementById("target-select") as HTMLSelectElement;
const listenBtn2 = document.getElementById("listen-btn-2") as HTMLButtonElement;
const gauge = document.getElementById("gauge") as HTMLCanvasElement;
const gctx = gauge.getContext("2d")!;
const chromaEl = document.getElementById("chroma")!;

let mode: AppMode = "tuner";
let chord: ChordReading | null = null;
let lastChordAt = 0;
let smoothClean = 0;
let targetChord = "";

// build chromagram bars
const chromaFills: HTMLElement[] = [];
const chromaBars: HTMLElement[] = [];
for (let i = 0; i < 12; i++) {
  const bar = document.createElement("div");
  bar.className = "chroma-bar";
  bar.innerHTML = `<span class="pc">${PITCH_CLASSES[i]}</span><div class="track"><div class="fill"></div></div>`;
  chromaEl.appendChild(bar);
  chromaBars.push(bar);
  chromaFills.push(bar.querySelector(".fill")!);
}

// mode switching
modeBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const m = btn.dataset.mode;
    if (m !== "tuner" && m !== "play") return;
    if (m === mode) return;
    // stop whatever is running when leaving a mode
    await invoke("stop_audio").catch(() => {});
    listening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);

    mode = m;
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    tunerView.hidden = m !== "tuner";
    playView.hidden = m !== "play";
    cornerLabel.textContent = m === "play" ? "ukejam / Chords · native" : "ukejam / Tuner · native";
  });
});

let chordListening = false;
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

targetSelect.addEventListener("change", () => {
  targetChord = targetSelect.value;
  invoke("set_target", { chord: targetChord || null }).catch(() => {});
});

listen<ChordReading>("chord", (event) => {
  chord = event.payload;
  lastChordAt = performance.now();
  setConn(true);
});

function renderChords() {
  const now = performance.now();
  if (chordListening && now - lastChordAt > 300) {
    chord = { active: false, detected: "", cleanliness: 0, chroma: new Array(12).fill(0), missing: [], extra: [], rms: 0 };
    if (now - lastChordAt > 1500) setConn(false);
  }

  const c = chord;
  if (c && c.active) {
    const pct = Math.round(c.cleanliness * 100);
    const clean = c.cleanliness >= 0.85;
    chordNameEl.textContent = c.detected;
    chordNameEl.className = "chord-name " + (clean ? "clean" : "dirty");
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    cleanValEl.innerHTML = `${pct}<span class="pct">%</span>`;
    cleanStatusEl.textContent = clean ? "clean" : pct >= 70 ? "almost" : "off";

    // coach text from missing/extra
    if (!targetChord) {
      coachEl.innerHTML = `<span class="ok">free play</span> · detecting`;
    } else if (c.missing.length === 0 && c.extra.length <= 1) {
      coachEl.innerHTML = `<span class="ok">nice — that's a clean ${targetChord} ✓</span>`;
    } else {
      const parts: string[] = [];
      if (c.missing.length)
        parts.push(`<span class="miss">missing ${c.missing.join(", ")}</span> — check that string is ringing`);
      if (c.extra.length)
        parts.push(`<span class="miss">extra ${c.extra.join(", ")}</span> — try muting`);
      coachEl.innerHTML = parts.join("<br>");
    }

    // chromagram
    const targetPcs = chordPitchClasses(targetChord);
    for (let i = 0; i < 12; i++) {
      chromaFills[i].style.width = `${Math.round((c.chroma[i] || 0) * 100)}%`;
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }
  } else {
    chordNameEl.textContent = "—";
    chordNameEl.className = "chord-name";
    smoothClean += (0 - smoothClean) * 0.15;
    cleanValEl.innerHTML = `0<span class="pct">%</span>`;
    cleanStatusEl.textContent = chordListening ? "listening" : "press start";
    coachEl.textContent = chordListening ? "play a chord" : "";
    for (let i = 0; i < 12; i++) chromaFills[i].style.width = "0%";
  }

  drawGauge(smoothClean, c?.active ?? false);
  requestAnimationFrame(renderChords);
}

// minimal chord -> pitch-class map for the chromagram target highlight
function chordPitchClasses(name: string): number[] {
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
    aug: [0, 4, 8],
    "5": [0, 7],
  };
  const iv = intervals[q] ?? [0, 4, 7];
  return iv.map((x) => (root + x) % 12);
}

function drawGauge(value: number, active: boolean) {
  const dpr = window.devicePixelRatio || 1;
  if (gauge.width !== 360 * dpr) {
    gauge.width = 360 * dpr;
    gauge.height = 220 * dpr;
  }
  const w = 360;
  const h = 220;
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h - 30;
  const r = 130;
  const start = Math.PI * 0.85;
  const end = Math.PI * 0.15 + Math.PI * 2; // 270-deg arc
  const sweep = end - start;

  // track
  gctx.lineWidth = 16;
  gctx.lineCap = "round";
  gctx.strokeStyle = "#16242a";
  gctx.beginPath();
  gctx.arc(cx, cy, r, start, end);
  gctx.stroke();

  // value arc
  const clean = value >= 0.85;
  const color = !active ? "#3a5450" : clean ? "#19e3c4" : "#f5c451";
  gctx.strokeStyle = color;
  gctx.shadowColor = color;
  gctx.shadowBlur = active ? 18 : 0;
  gctx.beginPath();
  gctx.arc(cx, cy, r, start, start + sweep * Math.min(1, Math.max(0, value)));
  gctx.stroke();
  gctx.shadowBlur = 0;
}

requestAnimationFrame(renderChords);
