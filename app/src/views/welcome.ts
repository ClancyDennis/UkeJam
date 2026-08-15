// The welcome flight: a one-shot splash that plays over the app on launch.
// The camera flies down a neon fretboard — four strings converging on the
// horizon, frets sweeping past, chord gates lighting up with their fingering
// and a little diagnostics readout as each one goes by — then pulls up into
// the ukejam wordmark, credit in the corner, and cross-fades away.
//
// Pure theatre, deliberately self-contained: nothing here reads or writes app
// state, and the app underneath is fully wired long before the overlay lifts,
// so the splash costs nothing but the seconds it is on screen. A tap or any
// key jumps to the wordmark; a second one dismisses it. prefers-reduced-motion
// skips the flight entirely and shows only the wordmark beat.

const TEAL = "25,227,196";
const GOLD = "245,196,81";

const FLY_MS = 5400; // the flight down the neck
const HOLD_MS = 2600; // wordmark hold before the fade
const Z_END = 56; // how far the camera travels, in world units
const FRET_STEP = 3; // world units between frets

// Strings left→right, standard tuning. World x of each string on the board;
// the board plane sits BOARD_Y below the camera axis so the strings read as a
// road, not a wall.
const STRING_X = [-0.78, -0.26, 0.26, 0.78];
const STRING_NAMES = ["G", "C", "E", "A"];
const BOARD_HALF = 1.06; // board edge, a little outside the outer strings
const BOARD_Y = 1.0;

interface Gate {
  z: number;
  name: string;
  /// Frets per string (standard G-C-E-A); 0 = open, null = muted.
  voicing: (number | null)[];
  /// Two HUD lines, in the app's diagnostics voice.
  diag: [string, string];
  side: 1 | -1; // which side of the board the readout floats on
  passedAt: number; // performance.now() when the camera crossed it (0 = not yet)
}

// The gates are the app's own first-lesson progression, and every readout is a
// number a real session actually shows (match %, onset timing, chroma peaks,
// the bar verdict) — the splash is a tour of the instrument panel, not lorem.
const GATES: Gate[] = [
  { z: 14, name: "C",  voicing: [0, 0, 0, 3], diag: ["match 97%", "4 strings clean"],            side: 1,  passedAt: 0 },
  { z: 25, name: "Am", voicing: [2, 0, 0, 0], diag: ["onset ▲ early 18 ms", "ease into the beat"], side: -1, passedAt: 0 },
  { z: 36, name: "F",  voicing: [2, 0, 1, 0], diag: ["chroma lock · 4 peaks", "flux 2.4× baseline"], side: 1,  passedAt: 0 },
  { z: 47, name: "G7", voicing: [0, 2, 1, 2], diag: ["cleanliness 94%", "verdict — HIT"],        side: -1, passedAt: 0 },
];

// Boot log, top-left: the "lab instrument warming up" beat. Timed so the last
// line lands just before the final gate.
const BOOT_LOG: { at: number; text: string }[] = [
  { at: 250,  text: "ukejam · boot" },
  { at: 750,  text: "mic ......... ok" },
  { at: 1250, text: "camera ...... ok" },
  { at: 1750, text: "tuning ...... G C E A" },
  { at: 2250, text: "voicings .... loaded" },
  { at: 2750, text: "latency ..... 11 ms" },
];

let overlay: HTMLElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let start = 0; // flight epoch (performance.now())
let holdMs = HOLD_MS;
let finaleShown = false;
let dismissed = false;
let lastStrumAt = -1e9; // drives the string ripple; reset at every gate pass

// Sine in-out rather than cubic: the gentler speed curve spreads the four
// gate passes evenly across the flight instead of bunching them into the
// fast middle and leaving a long empty tail before the wordmark.
function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function initWelcome(): void {
  overlay = document.getElementById("welcome-overlay")!;
  canvas = document.getElementById("welcome-canvas") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;

  // Warm the display faces so the first gate label isn't a fallback font.
  document.fonts?.load('700 24px "Chakra Petch"').catch(() => {});
  document.fonts?.load('400 12px "JetBrains Mono"').catch(() => {});

  start = performance.now();
  // Reduced motion: no flight, no ripple — open on the wordmark and leave
  // sooner. The overlay's own fade is a transition, which the global
  // reduced-motion rule already collapses.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    start -= FLY_MS;
    holdMs = 1400;
    GATES.forEach((g) => (g.passedAt = 1));
  }

  overlay.addEventListener("pointerdown", skip);
  window.addEventListener("keydown", skip);
  requestAnimationFrame(draw);
}

/// First interaction jumps to the wordmark; once it is up, interaction ends
/// the splash. Either way the player is never more than two taps from the app.
function skip(): void {
  if (dismissed) return;
  if (performance.now() - start < FLY_MS) {
    start = performance.now() - FLY_MS;
    // passedAt = 1: truthy but ancient, so no pass-flash fires on the jump.
    GATES.forEach((g) => { if (!g.passedAt) g.passedAt = 1; });
  } else {
    dismiss();
  }
}

function dismiss(): void {
  if (dismissed) return;
  dismissed = true;
  window.removeEventListener("keydown", skip);
  overlay.classList.add("out");
  // Keep drawing under the fade (the bloom drift covers the cross-over), then
  // drop the whole overlay from the DOM — it never runs twice.
  setTimeout(() => overlay.remove(), 950);
}

function draw(now: number): void {
  if (!overlay.isConnected) return; // dismissed and removed — stop the loop
  requestAnimationFrame(draw);

  const dpr = window.devicePixelRatio || 1;
  const rect = overlay.getBoundingClientRect();
  const w = rect.width || 800;
  const h = rect.height || 600;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const elapsed = now - start;
  const t = clamp01(elapsed / FLY_MS);
  // fin: 0 during the flight, ramping to 1 as the pull-up settles. Drives the
  // bloom, the teal→gold shift, and the horizon dropping (nose-up).
  const fin = clamp01((elapsed - FLY_MS) / 900);
  let cam = Z_END * easeInOutSine(t);
  if (elapsed > FLY_MS) cam += (elapsed - FLY_MS) * 0.0004; // idle creep under the wordmark

  const cx = w / 2;
  const hy = h * 0.40 + fin * h * 0.05; // horizon
  const F = h * 0.92; // focal length
  const proj = (x: number, y: number, rel: number) => {
    const k = F / rel;
    return { x: cx + x * k, y: hy + y * k, k };
  };

  // Gate passes happen regardless of what is drawn this frame.
  for (const g of GATES) {
    if (!g.passedAt && cam > g.z - 1.1) {
      g.passedAt = now;
      lastStrumAt = now;
    }
  }

  drawBloom(w, h, cx, hy, fin);
  drawBoard(cam, fin, proj, w);
  drawStrings(now, fin, cx, hy, F);
  for (const g of GATES) drawGate(g, cam, proj);
  drawPassFlash(now, w, h);
  drawBootLog(elapsed, fin);
  drawStringLabels(cx, hy, h, fin);

  if (!finaleShown && elapsed > FLY_MS + 200) {
    finaleShown = true;
    overlay.classList.add("on"); // CSS brings in the wordmark + credit
  }
  if (!dismissed && elapsed > FLY_MS + holdMs) dismiss();
}

/// The glow at the vanishing point: faint all flight, opening into the bloom
/// the wordmark sits in.
function drawBloom(w: number, h: number, cx: number, hy: number, fin: number): void {
  const r = h * (0.45 + fin * 0.75);
  const grad = ctx.createRadialGradient(cx, hy, 0, cx, hy, r);
  grad.addColorStop(0, `rgba(${TEAL},${0.10 + fin * 0.16})`);
  grad.addColorStop(0.55, `rgba(${TEAL},${0.03 + fin * 0.05})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/// Frets and position markers, rushing past. Both fade twice over: into the
/// horizon haze at the far end, and out as they pass under the camera.
function drawBoard(
  cam: number,
  fin: number,
  proj: (x: number, y: number, rel: number) => { x: number; y: number; k: number },
  w: number
): void {
  const firstFret = Math.max(1, Math.ceil((cam + 0.5) / FRET_STEP));
  for (let i = firstFret; ; i++) {
    const rel = i * FRET_STEP - cam;
    if (rel > 70) break;
    const haze = clamp01((70 - rel) / 30);
    const alpha = Math.min(1, 6 / rel) * haze * (0.30 - fin * 0.12);
    const a = proj(-BOARD_HALF, BOARD_Y, rel);
    const b = proj(BOARD_HALF, BOARD_Y, rel);
    ctx.strokeStyle = `rgba(${TEAL},${alpha})`;
    ctx.lineWidth = Math.max(0.6, Math.min(3, 5 / rel));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // inlay dot every 4th fret, centred in the fret behind the wire
    if (i % 4 === 2) {
      const m = proj(0, BOARD_Y, rel + FRET_STEP / 2);
      ctx.fillStyle = `rgba(${TEAL},${alpha * 0.9})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, Math.min(6, m.k * 0.045), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // board edges, one faint rail each side
  ctx.strokeStyle = `rgba(${TEAL},${0.10 - fin * 0.04})`;
  ctx.lineWidth = 1;
  for (const s of [-1, 1]) {
    const far = proj(s * BOARD_HALF, BOARD_Y, 68);
    const near = proj(s * BOARD_HALF, BOARD_Y, 0.55);
    ctx.beginPath();
    ctx.moveTo(far.x, far.y);
    ctx.lineTo(Math.max(-w, Math.min(2 * w, near.x)), near.y);
    ctx.stroke();
  }
}

/// The four strings, drawn as polylines so a gate pass can ripple down them —
/// the closest thing a splash has to a strum. They shift teal→gold as the
/// flight ends, matching the wordmark landing. Points are sampled evenly in
/// 1/z, which is evenly in screen space — no wasted segments at the horizon.
function drawStrings(now: number, fin: number, cx: number, hy: number, F: number): void {
  const SEGS = 26;
  const sinceStrum = now - lastStrumAt;
  const decay = Math.exp(-sinceStrum / 450);
  const col = fin > 0 ? lerpColor(TEAL, GOLD, fin * 0.8) : TEAL;
  for (let s = 0; s < STRING_X.length; s++) {
    ctx.beginPath();
    for (let i = 0; i <= SEGS; i++) {
      const u = i / SEGS; // 0 = horizon, 1 = near plane
      const invRel = (1 - u) * (1 / 68) + u * (1 / 0.55);
      const px = cx + STRING_X[s] * F * invRel;
      let py = hy + BOARD_Y * F * invRel;
      // ripple: strongest near the camera, dying with distance and time
      py += Math.sin(u * 22 - sinceStrum * 0.02 + s * 1.7) * 6 * u * decay;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    // glow pass then core — same trick the highway uses with shadowBlur
    ctx.strokeStyle = `rgba(${col},0.16)`;
    ctx.lineWidth = 5;
    ctx.shadowColor = `rgba(${col},0.7)`;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(${col},${0.55 + fin * 0.25})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/// One chord gate: the floating name token (highway-style), the fingering laid
/// out on the strings themselves, and the diagnostics block floating beside
/// the board. Everything scales with 1/distance, so the gate swells and
/// dissolves as the camera flies through it.
function drawGate(
  g: Gate,
  cam: number,
  proj: (x: number, y: number, rel: number) => { x: number; y: number; k: number }
): void {
  const rel = g.z - cam;
  if (rel < 0.9 || rel > 26) return;
  // long fade in from the horizon haze, quick fade out as the camera passes
  // through — and never more than a hint of the gate after next.
  const alpha = clamp01((26 - rel) / 12) * clamp01((rel - 0.9) / 1.6);
  if (alpha <= 0.01) return;
  // the nearest gate still ahead is the target and goes gold, like NOW on the highway
  const isNext = GATES.find((x) => x.z - cam > 0.9) === g;
  const col = isNext ? GOLD : TEAL;

  // fingering on the strings: filled dot = fretted, ring = open, × = muted
  for (let s = 0; s < STRING_X.length; s++) {
    const fret = g.voicing[s];
    const p = proj(STRING_X[s], BOARD_Y, rel);
    const r = Math.min(16, p.k * 0.062);
    ctx.globalAlpha = alpha;
    if (fret === null) {
      ctx.fillStyle = `rgba(${col},0.85)`;
      ctx.font = `700 ${Math.max(9, r * 1.7)}px "JetBrains Mono", monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("×", p.x, p.y);
    } else if (fret === 0) {
      ctx.strokeStyle = `rgba(${col},0.8)`;
      ctx.lineWidth = Math.max(1, r * 0.22);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.shadowColor = `rgba(${col},0.8)`;
      ctx.shadowBlur = r;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (p.k > 90) {
        // near enough to read: the fret number rides above its dot
        ctx.fillStyle = `rgba(${col},0.8)`;
        ctx.font = `500 ${Math.round(r * 1.15)}px "JetBrains Mono", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(String(fret), p.x, p.y - r * 1.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  // the name token, floating above the board at the gate's depth
  const c = proj(0, BOARD_Y - 1.35, rel);
  const tw = c.k * 1.0;
  const th = c.k * 0.46;
  ctx.globalAlpha = alpha;
  roundRect(ctx, c.x - tw / 2, c.y - th / 2, tw, th, c.k * 0.1);
  ctx.strokeStyle = `rgba(${col},${isNext ? 0.95 : 0.55})`;
  ctx.lineWidth = Math.max(1, c.k * 0.014);
  ctx.shadowColor = `rgba(${col},0.7)`;
  ctx.shadowBlur = isNext ? 16 : 8;
  ctx.stroke();
  ctx.fillStyle = `rgba(${col},0.06)`;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(${col},0.95)`;
  ctx.font = `700 ${Math.max(9, Math.min(72, Math.round(c.k * 0.26)))}px "Chakra Petch", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(g.name, c.x, c.y + 1);

  // diagnostics beside the board, tethered to the token with a leader line
  const da = clamp01((13 - rel) / 5) * clamp01((rel - 1.2) / 1.2) * alpha;
  if (da > 0.02) {
    const anchor = proj(g.side * 1.6, BOARD_Y - 0.95, rel);
    const edge = proj(g.side * 0.55, BOARD_Y - 1.35, rel);
    ctx.globalAlpha = da;
    ctx.strokeStyle = `rgba(${TEAL},0.35)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(edge.x, edge.y);
    ctx.lineTo(anchor.x, anchor.y - 6);
    ctx.stroke();
    ctx.font = '500 12px "JetBrains Mono", monospace';
    ctx.textAlign = g.side > 0 ? "left" : "right";
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgba(${TEAL},0.9)`;
    ctx.fillText(g.diag[0], anchor.x, anchor.y);
    ctx.fillStyle = `rgba(${TEAL},0.55)`;
    ctx.fillText(g.diag[1], anchor.x, anchor.y + 17);
  }
  ctx.globalAlpha = 1;
}

/// The strum flash when the camera crosses a gate: a frame-wide teal wash and
/// a gold strum line dropping down the near board, both gone in half a second.
/// (The string ripple, driven by lastStrumAt, carries the rest of the feel.)
function drawPassFlash(now: number, w: number, h: number): void {
  for (const g of GATES) {
    if (g.passedAt <= 1) continue;
    const q = (now - g.passedAt) / 450;
    if (q < 0 || q > 1) continue;
    ctx.fillStyle = `rgba(${TEAL},${0.06 * (1 - q)})`;
    ctx.fillRect(0, 0, w, h);
    const y = h * (0.58 + q * 0.5); // sweeps from mid-board off the bottom
    const half = w * (0.18 + q * 0.5);
    ctx.strokeStyle = `rgba(${GOLD},${0.5 * (1 - q)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = `rgba(${GOLD},0.8)`;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(w / 2 - half, y);
    ctx.lineTo(w / 2 + half, y);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

/// Boot log, top-left: appears line by line during the flight and fades under
/// the wordmark. The newest line carries a blinking cursor.
function drawBootLog(elapsed: number, fin: number): void {
  const alpha = 0.55 * (1 - fin);
  if (alpha <= 0.02) return;
  ctx.font = '400 11px "JetBrains Mono", monospace';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let shown = 0;
  for (const line of BOOT_LOG) if (line.at <= elapsed) shown++;
  for (let i = 0; i < shown; i++) {
    const isLast = i === shown - 1;
    const cursor = isLast && (elapsed / 500) % 2 < 1 ? " ▍" : "";
    ctx.fillStyle = `rgba(${TEAL},${alpha * (isLast ? 1 : 0.7)})`;
    ctx.fillText(BOOT_LOG[i].text + cursor, 24, 22 + i * 16);
  }
}

/// G · C · E · A under the near end of each string — the tuner's spelling,
/// pinned to a fixed screen row so it stays readable while the strings fly.
function drawStringLabels(cx: number, hy: number, h: number, fin: number): void {
  const alpha = 0.5 * (1 - fin);
  if (alpha <= 0.02) return;
  const py = h - 26;
  const k = (py - hy) / BOARD_Y; // the projection scale that lands strings on this row
  ctx.font = '500 12px "Chakra Petch", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(${TEAL},${alpha})`;
  for (let s = 0; s < STRING_X.length; s++) {
    const px = cx + STRING_X[s] * k;
    if (px > 20 && px < cx * 2 - 20) ctx.fillText(STRING_NAMES[s], px, py);
  }
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = a.split(",").map(Number);
  const pb = b.split(",").map(Number);
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(",");
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
