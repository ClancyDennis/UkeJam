// The radial cleanliness gauge: a square canvas with a 270-degree sweep and a
// centred readout. Fed the smoothed cleanliness value once per render frame.

let gauge: HTMLCanvasElement;
let gctx: CanvasRenderingContext2D;
let cleanValEl: HTMLElement;
let cleanStatusEl: HTMLElement;

/// The percentage + word under the dial. Written by the render loop as well as
/// by drawGauge, so it lives here with the canvas it belongs to.
export function setGaugeReadout(percentHtml: string, status: string): void {
  cleanValEl.innerHTML = percentHtml;
  cleanStatusEl.textContent = status;
}

export function initGauge(): void {
  gauge = document.getElementById("gauge") as HTMLCanvasElement;
  gctx = gauge.getContext("2d")!;
  cleanValEl = document.getElementById("clean-val")!;
  cleanStatusEl = document.getElementById("clean-status")!;
}

// --- radial cleanliness gauge (square canvas, 270deg sweep, centered readout) ---
export function drawGauge(value: number, active: boolean) {
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
