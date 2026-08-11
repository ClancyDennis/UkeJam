// The full-width live FFT spectrum: 96 log-spaced bins between 70 Hz and
// 2 kHz, matching the Rust `log_spectrum` binning exactly — the axis labels
// would lie otherwise. Bins belonging to the target chord's pitch classes glow
// gold, which is what makes a wrong note visible rather than merely audible.

import { PITCH_CLASSES } from "../../theory/chords.ts";

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

let fft: HTMLCanvasElement;
let fctx: CanvasRenderingContext2D;
let peaksListEl: HTMLElement;
let mPeakCountEl: HTMLElement;

export function initFft(): void {
  fft = document.getElementById("fft") as HTMLCanvasElement;
  fctx = fft.getContext("2d")!;
  peaksListEl = document.getElementById("peaks-list")!;
  mPeakCountEl = document.getElementById("m-peakcount")!;
}

/// Which pitch classes to light up gold. Set when the target chord changes.
export function setFftGoldPitchClasses(pcs: number[]): void {
  fftGoldPCs = pcs;
}

/// Ease the smoothed spectrum toward an incoming frame.
export function easeSpectrum(spectrum: number[]): void {
  for (let i = 0; i < FFT_BINS; i++) {
    const v = spectrum[i] ?? 0;
    smoothSpec[i] += (v - smoothSpec[i]) * 0.25;
  }
}

/// Decay the spectrum toward silence when nothing is sounding.
export function decaySpectrum(): void {
  for (let i = 0; i < FFT_BINS; i++) smoothSpec[i] += (0 - smoothSpec[i]) * 0.2;
}

export function drawFFT() {
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
