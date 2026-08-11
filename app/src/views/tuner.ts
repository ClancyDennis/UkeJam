// The tuner screen: needle, per-string readout, and the mic-calibration
// sampling the Setup screen drives.
//
// Owns its listening state. Everything else that needs to know — the "live"
// indicator, the keep-awake lock, the mode router, the iOS interruption
// handler — asks through isTunerListening() / stopTunerListening() rather than
// sharing a flag.

import { nativeInvoke, onNative, type TunerReading } from "../native.ts";
import { activeTuning } from "../tunings.ts";
import { currentMode } from "../state/appMode.ts";

export interface TunerDeps {
  /// Paint the shared "is the mic feeding us" indicator.
  setConn: (live: boolean) => void;
  /// Listening state changed; re-evaluate the iOS keep-awake lock.
  syncKeepAwake: () => void;
}

let deps: TunerDeps;

const IN_TUNE_CENTS = 5; // within +/- this many cents counts as in tune

// --- element refs (bound in initTuner) ---
let noteNameEl: HTMLElement;
let noteFreqEl: HTMLElement;
let centsValEl: HTMLElement;
let verdictEl: HTMLElement;
let listenBtn: HTMLButtonElement;
let stringsEl: HTMLElement;
let needle: HTMLCanvasElement;
let nctx: CanvasRenderingContext2D;

let listening = false;
let lastFrameAt = 0;
let smoothCents = 0; // eased needle position
let current: TunerReading | null = null;

// mic-calibration state (used by both audio listeners and the Setup screen)
let calibrating = false;
let calibSamples: number[] = [];
/// Feed one RMS reading to an in-progress calibration. Called from both audio
/// streams: the Setup screen runs the tuner, but a calibration started while
/// the chord detector is up must still collect.
export function noteTunerRms(rms: number) {
  if (calibrating) calibSamples.push(rms);
}

// --- build per-string rows (rebuilt when the tuning changes) ---
const stringRows = new Map<string, HTMLElement>();
export function rebuildStringRows() {
  stringsEl.textContent = "";
  stringRows.clear();
  for (const s of activeTuning().strings) {
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

// --- render loop ---
function render() {
  // Only the tuner view needs this loop; idle otherwise (keep self-rescheduling
  // so returning to the tuner resumes instantly).
  if (currentMode() !== "tuner") {
    requestAnimationFrame(render);
    return;
  }
  const now = performance.now();
  // If no frame for >300ms while listening, treat as silence/idle.
  if (listening && now - lastFrameAt > 300) {
    current = { active: false, freq: 0, nearest: "", cents: 0, rms: 0 };
    if (now - lastFrameAt > 1500) deps.setConn(false);
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

requestAnimationFrame(render);

/// Is the tuner's mic stream running? Read by the "live" indicator, the
/// keep-awake lock and the iOS interruption handler.
export function isTunerListening(): boolean {
  return listening;
}

/// Start the tuner mic and reflect it in the button. Throws if the mic won't
/// open — the interruption handler reports that to the player.
export async function startTunerListening(): Promise<void> {
  await nativeInvoke("start_tuner");
  listening = true;
  listenBtn.textContent = "Stop listening";
  listenBtn.classList.add("on");
}

/// Drop listening state and reset the button WITHOUT touching the native side.
/// Callers that also need the stream stopped invoke stop_audio themselves —
/// the mode router and the interruption handler both stop every stream at once.
export function stopTunerListening(): void {
  listening = false;
  listenBtn.textContent = "Start listening";
  listenBtn.classList.remove("on");
}

/// Start collecting RMS from the tuner stream for the Setup screen's mic
/// calibration. The readings arrive on the normal "tuner" event.
export function beginCalibration(): void {
  calibrating = true;
  calibSamples = [];
}

/// Stop collecting and hand back what was measured.
export function endCalibration(): number[] {
  calibrating = false;
  return calibSamples;
}

/// True while a calibration run is sampling, so the Setup screen can refuse to
/// start a second one.
export function isCalibrating(): boolean {
  return calibrating;
}

export function initTuner(d: TunerDeps): void {
  deps = d;
  noteNameEl = document.getElementById("note-name")!;
  noteFreqEl = document.getElementById("note-freq")!;
  centsValEl = document.getElementById("cents-val")!;
  verdictEl = document.getElementById("verdict")!;
  listenBtn = document.getElementById("listen-btn") as HTMLButtonElement;
  stringsEl = document.getElementById("strings")!;
  needle = document.getElementById("needle") as HTMLCanvasElement;
  nctx = needle.getContext("2d")!;

  rebuildStringRows();

  listenBtn.addEventListener("click", async () => {
    if (!listening) {
      try {
        await startTunerListening();
        deps.setConn(false);
        deps.syncKeepAwake();
      } catch (e) {
        verdictEl.textContent = `mic error: ${e}`;
      }
    } else {
      await nativeInvoke("stop_tuner");
      stopTunerListening();
      deps.setConn(false);
      deps.syncKeepAwake();
    }
  });

  // --- receive readings from Rust ---
  onNative<TunerReading>("tuner", (payload) => {
    current = payload;
    lastFrameAt = performance.now();
    deps.setConn(true);
    noteTunerRms(payload.rms);
  });

  window.addEventListener("resize", sizeCanvas);
  sizeCanvas();
  requestAnimationFrame(render);
}
