import { StrumCam, type MotionSample, type Stroke, type StrumCall } from "../strumcam.ts";
import { nativeInvoke } from "../native.ts";

export interface StrumCamDeps {
  /// True while StrumCam is the screen on show. Onsets arriving for other
  /// views must not be fed to the camera analyser.
  isActiveView: () => boolean;
  /// StrumCam drives the mic itself; the app needs to know so the iOS
  /// keep-awake lock and the listening state stay honest.
  setMicActive: (on: boolean) => void;
}

let deps: StrumCamDeps;

// =====================================================================
// StrumCam — camera strum-direction lab
// =====================================================================
// The mic's onset detector says WHEN a strum happened; the camera says WHICH
// WAY the hand was moving at that instant (see strumcam.ts for why the split
// runs exactly along that line). This view is the in-app feasibility rig: it
// surfaces every call with its evidence and tallies outcomes, so whether the
// motion signal is good enough to feed practice feedback is measured, not
// assumed.
let scPreview: HTMLCanvasElement;
let scStrip: HTMLCanvasElement;
let scStartBtn: HTMLButtonElement;
let scFlipEl: HTMLInputElement;
let scStatusEl: HTMLElement;
let scGlyphEl: HTMLElement;
let scCallsEl: HTMLElement;
let scCallsEmptyEl: HTMLElement;
let scDownsEl: HTMLElement;
let scUpsEl: HTMLElement;
let scUnsureEl: HTMLElement;
let scGhostsEl: HTMLElement;
let scFpsEl: HTMLElement;

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
export function strumcamOnset(t: number): void {
  if (!deps.isActiveView() || !strumcam.active) return;
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
    deps.setMicActive(true); // keeps the screen awake on iOS, like any mic use
  } catch (e) {
    // The camera alone still shows strokes and ghosts; say why calls won't come.
    scStatusEl.textContent = `camera live, mic error: ${e} — no onsets, so no calls`;
  }
  scStartBtn.textContent = "Stop";
  scStartBtn.classList.add("on");
  scRafId = requestAnimationFrame(scDrawStrip);
}

export function stopStrumcamSession(): void {
  if (strumcam.active) strumcam.stop();
  cancelAnimationFrame(scRafId);
  if (scMicOn) {
    scMicOn = false;
    deps.setMicActive(false);
    nativeInvoke("stop_audio").catch(() => {});
  }
  scStartBtn.textContent = "Start camera + mic";
  scStartBtn.classList.remove("on");
}

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

export function initStrumCam(d: StrumCamDeps): void {
  deps = d;
  scPreview = document.getElementById("sc-preview") as HTMLCanvasElement;
  scStrip = document.getElementById("sc-strip") as HTMLCanvasElement;
  scStartBtn = document.getElementById("sc-start") as HTMLButtonElement;
  scFlipEl = document.getElementById("sc-flip") as HTMLInputElement;
  scStatusEl = document.getElementById("sc-status")!;
  scGlyphEl = document.getElementById("sc-glyph")!;
  scCallsEl = document.getElementById("sc-calls")!;
  scCallsEmptyEl = document.getElementById("sc-calls-empty")!;
  scDownsEl = document.getElementById("sc-downs")!;
  scUpsEl = document.getElementById("sc-ups")!;
  scUnsureEl = document.getElementById("sc-unsure")!;
  scGhostsEl = document.getElementById("sc-ghosts")!;
  scFpsEl = document.getElementById("sc-fps")!;

  strumcam.attachPreview(scPreview);

  scFlipEl.addEventListener("change", () => {
    strumcam.flip = scFlipEl.checked;
  });

  scStartBtn.addEventListener("click", () => {
    if (strumcam.active) stopStrumcamSession();
    else void startStrumcamSession();
  });
}
