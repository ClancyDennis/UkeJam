// StrumCam: camera-based strum DIRECTION, fused with the mic's onset detector.
//
// The audio study (see README "Strum Direction") proved the mic can tell WHEN a
// strum happened to milliseconds but only commits to WHICH WAY on ~80% of
// strums, gated on chord shape — worst exactly on standard-tuning beginner
// shapes. A camera is the mirror image: a strumming hand moves visibly for
// 100+ ms per stroke, so even 30 fps trivially reads direction on essentially
// every strum — but it can't time string contact. So the split here is strict:
// the MIC owns *when* (its onset event is the trigger), the CAMERA only answers
// *which way the hand was moving at that instant*.
//
// Deliberately no ML. The first cut tracks the vertical velocity of the motion
// centroid between frames — the strumming hand is the dominant mover in a
// sensibly framed shot, and frame differencing needs no model download, no
// WASM, and no per-platform integration risk inside the Tauri webview. The
// analysis core below is pure (no DOM) so `verify:strumcam` can drive it with
// synthetic frames; if the simple signal proves insufficient on real hands, a
// landmark tracker (e.g. MediaPipe) can replace MotionField behind the same
// MotionSample stream without touching the fusion or the UI.
//
// Sign convention: +v = motion DOWN the frame (rows grow downward), which is a
// downstroke when the camera is upright facing the player. A rotated or
// mirrored-vertical mount flips it — that's the `flip` toggle in the view, not
// something the maths can know.

// ---------------------------------------------------------------------------
// Pure analysis core (no DOM — everything below is exercised by verify-strumcam)
// ---------------------------------------------------------------------------

export interface MotionSample {
  /// Timestamp, ms, performance.now() domain.
  t: number;
  /// Vertical velocity of the motion centroid, frame-heights per second.
  /// Positive = downward on screen.
  v: number;
  /// Motion centroid row, 0 = top .. 1 = bottom of frame.
  y: number;
  /// Mean per-pixel |frame difference| (0..255). Doubles as the sample's
  /// weight: vigorous motion is worth more than a flicker.
  energy: number;
}

export interface StrumCall {
  dir: "down" | "up" | "unknown";
  /// |weighted mean velocity| in frame-heights/sec (0 when unknown-no-data).
  speed: number;
  /// Weighted fraction of window samples agreeing with the mean's sign, 0..1.
  consistency: number;
  /// Samples that fell inside the decision window.
  samples: number;
  /// Why the call is "unknown", for the diagnostics list.
  reason?: string;
}

export interface Stroke {
  t0: number;
  t1: number;
  dir: "down" | "up";
  /// Peak |velocity| during the stroke, frame-heights/sec.
  peak: number;
}

export interface MotionFieldOptions {
  /// Mean per-pixel |diff| below this is treated as a still frame (sensor
  /// noise), producing no sample. 0..255 scale.
  energyFloor?: number;
  /// EMA factor applied to the raw centroid velocity (1 = no smoothing).
  ema?: number;
}

/// Frame-difference motion tracker. Feed grayscale frames; get back one
/// MotionSample per frame of visible motion. The centroid of |cur - prev|
/// covers both the vacated and newly-occupied pixels of whatever moved, so it
/// travels with the mover at the mover's speed.
export class MotionField {
  private readonly w: number;
  private readonly h: number;
  private readonly energyFloor: number;
  private readonly ema: number;
  private prev: Uint8Array | null = null;
  private prevT = 0;
  private lastY: number | null = null;
  private lastV = 0;

  constructor(width: number, height: number, opts: MotionFieldOptions = {}) {
    this.w = width;
    this.h = height;
    this.energyFloor = opts.energyFloor ?? 3.5;
    this.ema = opts.ema ?? 0.5;
  }

  /// One grayscale frame (w*h bytes, row-major). Returns a sample when there
  /// is measurable motion AND a previous motion frame to take velocity from.
  feed(gray: Uint8Array | Uint8ClampedArray, t: number): MotionSample | null {
    const { w, h } = this;
    const prev = this.prev;
    // keep a copy for next time regardless of what we decide about this frame
    this.prev = Uint8Array.from(gray);
    if (!prev) {
      this.prevT = t;
      return null;
    }

    let total = 0;
    let weighted = 0;
    for (let r = 0; r < h; r++) {
      let rowE = 0;
      const base = r * w;
      for (let c = 0; c < w; c++) {
        rowE += Math.abs(gray[base + c] - prev[base + c]);
      }
      total += rowE;
      weighted += (r + 0.5) * rowE;
    }
    const energy = total / (w * h);
    const dt = (t - this.prevT) / 1000;
    this.prevT = t;

    if (energy < this.energyFloor) {
      // Still frame: drop the velocity chain so a long pause doesn't produce a
      // huge fake velocity when motion resumes somewhere else in the frame.
      this.lastY = null;
      this.lastV = 0;
      return null;
    }

    const y = weighted / total / h; // 0..1, top..bottom
    if (this.lastY === null || dt <= 0 || dt > 0.25) {
      // First moving frame (or a stall): position is valid, velocity isn't yet.
      this.lastY = y;
      this.lastV = 0;
      return null;
    }

    const raw = Math.max(-8, Math.min(8, (y - this.lastY) / dt));
    const v = this.lastV + this.ema * (raw - this.lastV);
    this.lastY = y;
    this.lastV = v;
    return { t, v, y, energy };
  }
}

export interface ClassifyOptions {
  /// Half-width of the decision window around the onset, ms. Generous on
  /// purpose: a stroke's motion phase is ~100+ ms and both the audio event and
  /// the camera frames carry a few tens of ms of pipeline lag each.
  windowMs?: number;
  /// Weighted mean |velocity| below this is "hand barely moving", h/s.
  minSpeed?: number;
  /// Sign agreement below this is "not a single sweep".
  minConsistency?: number;
  /// Fewer window samples than this is "no motion data".
  minSamples?: number;
}

/// Direction of the hand at the moment the MIC said a strum happened.
/// `samples` is any recent-history buffer that covers the window; order and
/// extra samples outside the window don't matter.
export function classifyStrum(
  samples: readonly MotionSample[],
  onsetT: number,
  opts: ClassifyOptions = {}
): StrumCall {
  const windowMs = opts.windowMs ?? 110;
  const minSpeed = opts.minSpeed ?? 0.35;
  const minConsistency = opts.minConsistency ?? 0.7;
  const minSamples = opts.minSamples ?? 3;

  const win = samples.filter((s) => Math.abs(s.t - onsetT) <= windowMs);
  if (win.length < minSamples) {
    return {
      dir: "unknown",
      speed: 0,
      consistency: 0,
      samples: win.length,
      reason: "no motion in frame",
    };
  }

  // Energy-weighted mean velocity, tapered toward the onset so motion right at
  // the strum outvotes the wind-up and the follow-through.
  let sumW = 0;
  let sumWV = 0;
  for (const s of win) {
    const w = s.energy * (1 - Math.abs(s.t - onsetT) / (windowMs + 1));
    sumW += w;
    sumWV += w * s.v;
  }
  const mean = sumW > 0 ? sumWV / sumW : 0;
  const speed = Math.abs(mean);

  let agree = 0;
  for (const s of win) {
    const w = s.energy * (1 - Math.abs(s.t - onsetT) / (windowMs + 1));
    if (s.v * mean > 0) agree += w;
  }
  const consistency = sumW > 0 ? agree / sumW : 0;

  if (speed < minSpeed) {
    return { dir: "unknown", speed, consistency, samples: win.length, reason: "hand barely moving" };
  }
  if (consistency < minConsistency) {
    return { dir: "unknown", speed, consistency, samples: win.length, reason: "motion not one sweep" };
  }
  return { dir: mean > 0 ? "down" : "up", speed, consistency, samples: win.length };
}

export interface StrokeTrackerOptions {
  /// |v| that starts (and re-arms) a stroke, h/s. Matches classify's minSpeed.
  minSpeed?: number;
  /// A stroke shorter than this is a twitch, not a stroke, ms.
  minDurMs?: number;
  /// How long |v| may sag below half-speed before the stroke is closed, ms.
  endGraceMs?: number;
}

/// Segments the velocity stream into discrete strokes, independent of audio.
/// A stroke with no audio onset near it is a GHOST — the hand swept but no
/// string sounded. That's not noise: "keep the hand moving and miss the
/// strings on silent beats" is how strumming rhythm is taught, and ghosts are
/// invisible to the microphone by definition.
export class StrokeTracker {
  private readonly minSpeed: number;
  private readonly minDurMs: number;
  private readonly endGraceMs: number;
  private cur: { t0: number; dir: "down" | "up"; peak: number; lastFastT: number } | null = null;

  constructor(opts: StrokeTrackerOptions = {}) {
    this.minSpeed = opts.minSpeed ?? 0.35;
    this.minDurMs = opts.minDurMs ?? 50;
    this.endGraceMs = opts.endGraceMs ?? 70;
  }

  /// Feed every MotionSample in order. Returns a stroke at the moment it ends.
  feed(s: MotionSample): Stroke | null {
    const speed = Math.abs(s.v);
    const dir: "down" | "up" = s.v > 0 ? "down" : "up";
    const cur = this.cur;

    if (!cur) {
      if (speed >= this.minSpeed) {
        this.cur = { t0: s.t, dir, peak: speed, lastFastT: s.t };
      }
      return null;
    }

    if (dir === cur.dir && speed >= this.minSpeed / 2) {
      if (speed >= this.minSpeed) cur.lastFastT = s.t;
      cur.peak = Math.max(cur.peak, speed);
      return null;
    }

    if (dir !== cur.dir && speed >= this.minSpeed) {
      // Instant reversal: close the old stroke and open the new one.
      const done = this.close();
      this.cur = { t0: s.t, dir, peak: speed, lastFastT: s.t };
      return done;
    }

    if (s.t - cur.lastFastT > this.endGraceMs) return this.close();
    return null;
  }

  /// Force-close (e.g. when the camera stops). Returns the pending stroke.
  flush(): Stroke | null {
    return this.close();
  }

  private close(): Stroke | null {
    const cur = this.cur;
    this.cur = null;
    if (!cur) return null;
    if (cur.lastFastT - cur.t0 < this.minDurMs) return null;
    return { t0: cur.t0, t1: cur.lastFastT, dir: cur.dir, peak: cur.peak };
  }
}

// ---------------------------------------------------------------------------
// Camera capture layer (DOM). Kept as thin as possible: grab frames, downscale
// to a tiny luma grid, feed the core, ring-buffer the samples, and answer the
// one question main.ts asks: "the mic heard a strum at time T — which way?"
// ---------------------------------------------------------------------------

/// Analysis grid. Tiny on purpose: at 64x48 a frame diff is ~3k adds, nothing
/// at 30 fps, and hand-scale motion survives heavy downscaling just fine.
const GRID_W = 64;
const GRID_H = 48;
/// How much history the sample ring keeps, ms. Must comfortably exceed the
/// classify window plus scheduling slack.
const RING_MS = 5000;
/// The call for an onset is made this long after the onset, so the window has
/// its trailing samples. Latency is fine: this feeds a tally, not the highway.
const DECIDE_DELAY_MS = 160;
/// A stroke with no onset within this distance is a ghost.
const GHOST_MATCH_MS = 180;

export interface StrumCamEvents {
  /// Every motion sample, for the live trace.
  onSample?: (s: MotionSample) => void;
  /// A direction call for a mic onset (fires DECIDE_DELAY_MS after the onset).
  onCall?: (call: StrumCall, onsetT: number) => void;
  /// A completed hand stroke; `ghost` = no mic onset anywhere near it.
  onStroke?: (stroke: Stroke, ghost: boolean) => void;
  /// Camera status line for the UI.
  onStatus?: (msg: string) => void;
}

export class StrumCam {
  /// Flip the up/down sense for rotated mounts. Applied at the sample source
  /// so the trace, calls and strokes all agree.
  flip = false;

  private readonly events: StrumCamEvents;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly grab = document.createElement("canvas");
  private readonly grabCtx = this.grab.getContext("2d", { willReadFrequently: true })!;
  private preview: HTMLCanvasElement | null = null;
  private field = new MotionField(GRID_W, GRID_H);
  private strokes = new StrokeTracker();
  private samples: MotionSample[] = [];
  private onsets: number[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private rafId = 0;
  private running = false;
  private frames = 0;
  private fpsAt = 0;
  fps = 0;

  constructor(events: StrumCamEvents = {}) {
    this.events = events;
    this.grab.width = GRID_W;
    this.grab.height = GRID_H;
  }

  get active(): boolean {
    return this.running;
  }

  /// The view's preview canvas; the capture loop paints the mirrored camera
  /// image plus the motion centroid into it. Null detaches.
  attachPreview(canvas: HTMLCanvasElement | null): void {
    this.preview = canvas;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.events.onStatus?.("asking for camera…");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
    });
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.stream;
    await video.play();
    this.video = video;
    this.field = new MotionField(GRID_W, GRID_H);
    this.strokes = new StrokeTracker();
    this.samples = [];
    this.onsets = [];
    this.frames = 0;
    this.fpsAt = performance.now();
    this.running = true;
    this.events.onStatus?.("camera live");
    this.tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.events.onStatus?.("camera off");
  }

  /// The mic heard a strum at `t` (performance.now() domain). Schedule a
  /// direction call once the trailing half of the window has been captured.
  noteOnset(t: number): void {
    if (!this.running) return;
    this.onsets.push(t);
    if (this.onsets.length > 64) this.onsets.shift();
    const timer = setTimeout(() => {
      if (!this.running) return;
      this.events.onCall?.(classifyStrum(this.samples, t), t);
    }, DECIDE_DELAY_MS);
    this.timers.push(timer);
    if (this.timers.length > 64) this.timers.shift();
  }

  private tick = (): void => {
    if (!this.running || !this.video) return;
    // requestVideoFrameCallback paces to actual camera frames where available;
    // rAF otherwise (same cost — a repeated frame diffs to zero energy).
    const rvfc = (this.video as any).requestVideoFrameCallback?.bind(this.video);
    if (rvfc) rvfc(this.tick);
    else this.rafId = requestAnimationFrame(this.tick);
    this.processFrame(performance.now());
  };

  private processFrame(t: number): void {
    const video = this.video!;
    if (video.readyState < 2) return;
    this.grabCtx.drawImage(video, 0, 0, GRID_W, GRID_H);
    const rgba = this.grabCtx.getImageData(0, 0, GRID_W, GRID_H).data;
    const gray = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < gray.length; i++) {
      const j = i * 4;
      gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }

    this.frames++;
    if (t - this.fpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (t - this.fpsAt));
      this.frames = 0;
      this.fpsAt = t;
    }

    const raw = this.field.feed(gray, t);
    const sample = raw && this.flip ? { ...raw, v: -raw.v, y: 1 - raw.y } : raw;
    if (sample) {
      this.samples.push(sample);
      const cutoff = t - RING_MS;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
      this.events.onSample?.(sample);

      const stroke = this.strokes.feed(sample);
      if (stroke) this.emitStroke(stroke);
    }
    this.drawPreview(sample);
  }

  private emitStroke(stroke: Stroke): void {
    // Ghost status can't be decided at stroke end: the matching onset may be
    // an audio-pipeline lag behind. Decide after the match window has passed.
    const timer = setTimeout(() => {
      if (!this.running) return;
      const ghost = !this.onsets.some(
        (o) => o >= stroke.t0 - GHOST_MATCH_MS && o <= stroke.t1 + GHOST_MATCH_MS
      );
      this.events.onStroke?.(stroke, ghost);
    }, GHOST_MATCH_MS + DECIDE_DELAY_MS);
    this.timers.push(timer);
    if (this.timers.length > 64) this.timers.shift();
  }

  private drawPreview(sample: MotionSample | null): void {
    const canvas = this.preview;
    const video = this.video;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    // Mirror horizontally so the preview behaves like a mirror; vertical (the
    // axis direction lives on) is untouched.
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
    if (sample) {
      const y = (this.flip ? 1 - sample.y : sample.y) * height;
      ctx.strokeStyle = "rgba(25, 227, 196, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      // arrowhead showing the current travel direction at the frame edge
      const vRaw = this.flip ? -sample.v : sample.v;
      if (Math.abs(vRaw) > 0.15) {
        const dy = vRaw > 0 ? 12 : -12;
        ctx.fillStyle = "rgba(245, 196, 81, 0.95)";
        ctx.beginPath();
        ctx.moveTo(width - 16, y + dy);
        ctx.lineTo(width - 22, y);
        ctx.lineTo(width - 10, y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}
