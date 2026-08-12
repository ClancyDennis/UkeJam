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
// Two tracking backends produce the same MotionSample stream:
//
//   "hand"   — MediaPipe HandLandmarker (on-device, WASM). Tracks the palm
//              centroid of the strumming hand, immune to background motion,
//              and yields a full 21-point skeleton — which is also the raw
//              material for hand graphics on the practice highway later.
//   "motion" — dependency-free frame differencing: vertical velocity of the
//              motion centroid on a tiny luma grid. The automatic fallback
//              when the model assets aren't present (they're fetched at build
//              time, not committed) or the model fails to load in the webview.
//
// Everything downstream of the sample stream — the direction call at an onset,
// stroke segmentation, ghosts, the UI — is backend-agnostic, and the analysis
// core is pure (no DOM) so `verify:strumcam` drives it with synthetic input.
//
// Sign convention: +v = motion DOWN the frame (rows grow downward), which is a
// downstroke when the camera is upright facing the player. A rotated or
// mirrored-vertical mount flips it — that's the `flip` toggle in the view, not
// something the maths can know.

import type { HandLandmarker } from "@mediapipe/tasks-vision";

// ---------------------------------------------------------------------------
// Pure analysis core (no DOM — everything below is exercised by verify-strumcam)
// ---------------------------------------------------------------------------

export interface MotionSample {
  /// Timestamp, ms, performance.now() domain.
  t: number;
  /// Vertical velocity of the tracked point, frame-heights per second.
  /// Positive = downward on screen.
  v: number;
  /// Tracked point's row, 0 = top .. 1 = bottom of frame.
  y: number;
  /// Sample weight for the direction call. Frame differencing puts its mean
  /// per-pixel |diff| here (vigorous motion counts for more); the hand tracker
  /// puts its detection confidence (scaled) here.
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

/// The flux ratio the Rust detector requires before it fires an onset
/// (ONSET_RATIO in audio.rs). Mirrored here ONLY so the lab can print a stroke's
/// flux against the bar it was judged by — a hardcoded copy silently lied about the
/// threshold the moment the detector was retuned.
export const ONSET_RATIO_MIRROR = 1.8;

/// One audio window's spectral flux, as reported by the detector.
export interface FluxSample {
  t: number;
  /// Flux as a multiple of its own slow baseline. 1.0 is steady state; the Rust
  /// detector fires an onset at ONSET_RATIO (2.2) plus a rising test.
  ratio: number;
}

/// A stroke with no onset within this distance is a ghost. Also the span
/// fluxAroundStroke measures over, so "was it heard" and "how loud was it" are always
/// answered about the same slice of time.
const GHOST_MATCH_MS = 180;

/// How loud the strings were around a hand stroke — measurement only.
///
/// This exists to answer one question with numbers instead of a guess: when a
/// stroke produces NO onset, was the sweep silent (a real ghost) or was it a quiet
/// strum the audio threshold missed? Soft upstrokes land in that gap today and are
/// counted as ghosts, which matters because ghosts are already scored and reported
/// to the coach as a good thing.
///
/// Camera-led by design. Relaxing the audio threshold whenever the hand sweeps
/// cannot work for a player who only ever plays downstrokes — the relaxation would
/// be permanently on, which is just a lower global threshold, and that is what
/// caused 95 onsets for 46 real strums before the rising test was added. The stroke
/// boundary is the same event whether the pattern is D D D D or D U D U, so the
/// question is asked AT that boundary rather than continuously.
///
/// Reports peak flux in the window, since a strum's attack is a spike a few tens of
/// ms wide and an average over the whole stroke would bury it.
export function fluxAroundStroke(
  flux: readonly FluxSample[],
  stroke: Stroke,
  /// How far either side of the stroke to look, ms. Defaults to GHOST_MATCH_MS so
  /// this measures over EXACTLY the span the ghost decision uses — with a narrower
  /// pad, a stroke could be marked "heard" from an onset the flux window never saw,
  /// printing a contradiction ("heard" next to flux 0.61x) on the same row.
  padMs = GHOST_MATCH_MS
): { peak: number; samples: number } {
  const from = stroke.t0 - padMs;
  const to = stroke.t1 + padMs;
  let peak = 0;
  let samples = 0;
  for (const f of flux) {
    if (f.t < from || f.t > to) continue;
    samples++;
    if (f.ratio > peak) peak = f.ratio;
  }
  return { peak, samples };
}

export interface VelocityChainOptions {
  /// EMA factor applied to the raw velocity (1 = no smoothing).
  ema?: number;
  /// A gap between samples longer than this breaks the chain, ms — otherwise a
  /// pause followed by reappearance elsewhere reads as one huge fake sweep.
  maxGapMs?: number;
}

/// Turns a stream of (y, t) positions into smoothed velocity samples. Shared
/// by both backends so their streams behave identically downstream.
export class VelocityChain {
  private readonly ema: number;
  private readonly maxGapMs: number;
  private lastY: number | null = null;
  private lastT = 0;
  private lastV = 0;

  constructor(opts: VelocityChainOptions = {}) {
    this.ema = opts.ema ?? 0.5;
    this.maxGapMs = opts.maxGapMs ?? 250;
  }

  /// Position is 0..1 top..bottom; weight becomes the sample's energy.
  feed(y: number, t: number, weight: number): MotionSample | null {
    const dt = t - this.lastT;
    const chained = this.lastY !== null && dt > 0 && dt <= this.maxGapMs;
    const prevY = this.lastY;
    this.lastY = y;
    this.lastT = t;
    if (!chained || prevY === null) {
      // First sighting (or a stall): position is valid, velocity isn't yet.
      this.lastV = 0;
      return null;
    }
    const raw = Math.max(-8, Math.min(8, ((y - prevY) / dt) * 1000));
    const v = this.lastV + this.ema * (raw - this.lastV);
    this.lastV = v;
    return { t, v, y, energy: weight };
  }

  /// The tracked thing vanished (stillness, hand out of frame, low score).
  reset(): void {
    this.lastY = null;
    this.lastV = 0;
  }
}

export interface MotionFieldOptions extends VelocityChainOptions {
  /// Mean per-pixel |diff| below this is treated as a still frame (sensor
  /// noise), producing no sample. 0..255 scale.
  energyFloor?: number;
}

/// Frame-difference motion tracker — the no-model fallback backend. Feed
/// grayscale frames; get back one MotionSample per frame of visible motion.
/// The centroid of |cur - prev| covers both the vacated and newly-occupied
/// pixels of whatever moved, so it travels with the mover at the mover's speed.
export class MotionField {
  private readonly w: number;
  private readonly h: number;
  private readonly energyFloor: number;
  private readonly chain: VelocityChain;
  private prev: Uint8Array | null = null;

  constructor(width: number, height: number, opts: MotionFieldOptions = {}) {
    this.w = width;
    this.h = height;
    this.energyFloor = opts.energyFloor ?? 3.5;
    this.chain = new VelocityChain(opts);
  }

  /// One grayscale frame (w*h bytes, row-major). Returns a sample when there
  /// is measurable motion AND a previous motion frame to take velocity from.
  feed(gray: Uint8Array | Uint8ClampedArray, t: number): MotionSample | null {
    const { w, h } = this;
    const prev = this.prev;
    // keep a copy for next time regardless of what we decide about this frame
    this.prev = Uint8Array.from(gray);
    if (!prev) return null;

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
    if (energy < this.energyFloor) {
      this.chain.reset();
      return null;
    }
    return this.chain.feed(weighted / total / h, t, energy);
  }
}

/// Weight scale for hand-tracker samples: a confident detection should count
/// like healthy motion energy does on the fallback path (which sits around
/// 10–40 on the 0..255 |diff| scale for a real strumming hand).
const HAND_WEIGHT = 30;

/// One hand as the tracker reports it, with the label MediaPipe assigns.
export interface HandCandidate {
  points: readonly HandPoint[];
  /// "Left" / "Right" as MediaPipe names it, in MIRRORED (selfie) terms — see
  /// pickStrummingHand for why the label alone can't be trusted.
  label: string;
  /// Handedness confidence, 0..1.
  score: number;
}

/// What the picker remembers between frames.
export interface HandTrack {
  /// Palm row of the hand currently being tracked.
  y: number;
  /// Palm rows of EVERY hand seen last frame, so movement can be estimated without
  /// persistent ids (MediaPipe provides none).
  rows: readonly number[];
}

export interface PickOptions {
  /// How far, in frame heights, a hand may move between frames and still be taken
  /// for the same hand continuing.
  maxJump?: number;
  /// Row change per frame above which a hand counts as MOVING. At 30fps a strum
  /// covers ~0.1 frame-heights per frame, while a fretting hand holding a chord
  /// covers almost nothing, so this sits well below a strum and above jitter.
  movingY?: number;
}

/// Which hand is doing the strumming.
///
/// With numHands: 1 the tracker returned whatever hand it happened to find, so the
/// moment the strumming hand left frame it locked onto the FRETTING hand and kept
/// reporting at full confidence. That is worse than losing tracking: the fretting
/// hand slides along the neck, producing real vertical velocity, so every direction
/// call stayed confident while describing the wrong hand.
///
/// Handedness labels alone don't settle it. MediaPipe labels in mirrored selfie
/// terms, players strum with either hand, and a rotated or rear-facing mount flips
/// the sense again — a left-handed player would be tracked on the wrong hand by any
/// fixed rule. So the choice is made from BEHAVIOUR, which is the same for every
/// player: the strumming hand moves vertically and the fretting hand does not.
///
/// `prevY` is the last accepted palm row, so an established track is preferred over
/// a hand that merely happens to be nearer the middle of the frame this instant.
/// Without that the pick oscillates between hands mid-strum, chopping the velocity
/// chain into fragments too short to call.
export function pickStrummingHand(
  hands: readonly HandCandidate[],
  prev: HandTrack | null,
  opts: PickOptions = {}
): HandCandidate | null {
  const maxJump = opts.maxJump ?? 0.2;
  const movingY = opts.movingY ?? 0.015;
  const usable = hands.filter((h) => h.points.length >= 21);
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0];

  // ACTIVITY FIRST. The strumming hand is the one that moves — that is the whole
  // premise, and the only property that holds for every player regardless of
  // handedness or camera mount.
  //
  // An earlier version led with continuity ("stay on whichever hand is nearest to
  // where the tracked hand just was") and that inverted the test. A fretting hand
  // sitting still is ALWAYS nearest to where it just was, so once the track latched
  // onto it, a vigorously strumming hand could never win it back: the rule rewarded
  // stillness, which is the opposite of the signal. That is the "grabs the left hand
  // and won't go back" bug.
  //
  // `prev` carries each hand's previous row keyed by its position in the last frame's
  // list, which is stable enough frame to frame for a movement estimate; MediaPipe
  // does not give persistent ids, so nearest-match is the available proxy.
  if (prev && prev.rows.length) {
    const withMotion = usable.map((h) => {
      const y = palmY(h.points);
      // Distance to the closest known row from last frame == how far this hand moved,
      // assuming the nearest previous row was this same hand.
      const dy = Math.min(...prev.rows.map((r) => Math.abs(y - r)));
      return { h, y, dy };
    });
    const active = withMotion.filter((m) => m.dy >= movingY).sort((a, b) => b.dy - a.dy);
    if (active.length === 1) return active[0].h;
    if (active.length > 1) {
      // Both hands moving (a chord change sweeps the fretting hand too). Among the
      // movers, prefer the one continuing the existing track, so a normal strum does
      // not hand off mid-sweep and fragment the velocity chain.
      const cont = active
        .map((m) => ({ ...m, d: Math.abs(m.y - prev.y) }))
        .sort((a, b) => a.d - b.d);
      return cont[0].d < maxJump ? cont[0].h : active[0].h;
    }
    // Nothing moving: hold the current track rather than flip-flopping on detector
    // noise while the player is idle between phrases.
    const held = withMotion
      .map((m) => ({ ...m, d: Math.abs(m.y - prev.y) }))
      .sort((a, b) => a.d - b.d)[0];
    if (held.d < maxJump) return held.h;
  }

  // No usable history: prefer the more confident detection, tie-broken by frame
  // position so the choice cannot chatter between frames.
  return usable
    .slice()
    .sort((a, b) => b.score - a.score || palmY(a.points) - palmY(b.points))[0];
}

export interface HandMotionOptions extends VelocityChainOptions {
  /// Detections scoring below this are treated as "no hand".
  minScore?: number;
}

/// Position→velocity adapter for the hand-landmark backend: feed the tracked
/// palm row (or null when no hand is seen) and the detection score. Low-score
/// and no-hand frames break the velocity chain, so the hand re-entering the
/// frame far from where it left never reads as a sweep.
export class HandMotion {
  private readonly minScore: number;
  private readonly chain: VelocityChain;

  constructor(opts: HandMotionOptions = {}) {
    this.minScore = opts.minScore ?? 0.5;
    this.chain = new VelocityChain(opts);
  }

  feed(y: number | null, t: number, score = 1): MotionSample | null {
    if (y === null || score < this.minScore) {
      this.chain.reset();
      return null;
    }
    return this.chain.feed(y, t, HAND_WEIGHT * score);
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
// Hand skeleton drawing — exported so other surfaces (the practice highway's
// future graphics layer) can render the same hand the tracker sees.
// ---------------------------------------------------------------------------

/// The 21 HandLandmarker points in normalized video coordinates. Structurally
/// compatible with MediaPipe's NormalizedLandmark so callers don't need the
/// library's types.
export interface HandPoint {
  x: number;
  y: number;
}

/// Bone list of the 21-point hand model (wrist, thumb, four fingers).
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [0, 17],                                  // palm edge
];

export interface DrawHandOptions {
  /// Mirror horizontally (for a selfie-style preview). Default true.
  mirror?: boolean;
  color?: string;
  jointColor?: string;
  lineWidth?: number;
}

/// Paint a hand skeleton over a w×h canvas region.
export function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: readonly HandPoint[],
  w: number,
  h: number,
  opts: DrawHandOptions = {}
): void {
  if (hand.length < 21) return;
  const mirror = opts.mirror ?? true;
  const px = (p: HandPoint) => (mirror ? (1 - p.x) * w : p.x * w);
  const py = (p: HandPoint) => p.y * h;

  ctx.strokeStyle = opts.color ?? "rgba(25, 227, 196, 0.85)";
  ctx.lineWidth = opts.lineWidth ?? 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(px(hand[a]), py(hand[a]));
    ctx.lineTo(px(hand[b]), py(hand[b]));
  }
  ctx.stroke();

  ctx.fillStyle = opts.jointColor ?? "rgba(245, 196, 81, 0.9)";
  for (const p of hand) {
    ctx.beginPath();
    ctx.arc(px(p), py(p), (opts.lineWidth ?? 2) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

/// The palm centroid row (wrist + the four finger knuckles): the point whose
/// vertical travel is the strum. Fingertips flick and blur; the palm moves
/// with the stroke.
export function palmY(hand: readonly HandPoint[]): number {
  return (hand[0].y + hand[5].y + hand[9].y + hand[13].y + hand[17].y) / 5;
}

/// How much of the hand's own size to pad the spotlight by, so the glow reads as
/// lighting the hand rather than clipping it at the knuckles.
const SPOTLIGHT_PAD = 0.55;
/// Floor on the spotlight radius as a fraction of the frame's smaller side. A
/// hand far from the camera covers few pixels, and a spotlight that tracked its
/// bounding box exactly would shrink to a dot the player can't see.
const SPOTLIGHT_MIN_R = 0.13;
/// How far the un-spotlit frame is darkened. Enough to push the background back
/// without hiding it: the player still needs to see whether they are framed, and
/// a near-black surround would make a mistracked hand harder to diagnose, not
/// easier.
const DIM_ALPHA = 0.62;

/// Where to put the "lit" circle for a tracked hand, in normalized (0..1)
/// coordinates against a `w`x`h` frame. Separated from the drawing so the
/// geometry is testable without a canvas — the radius rules below are the part
/// that can be wrong in a way no unit test of the drawing calls would catch.
///
/// `mirror` matches drawHand's convention so the spotlight lands on the hand as
/// the player sees it, not on its un-mirrored twin across the frame.
export function spotlightFor(
  hand: readonly HandPoint[],
  w: number,
  h: number,
  mirror = true
): { x: number; y: number; r: number } | null {
  if (hand.length < 21) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of hand) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Half-diagonal in PIXELS, not normalized units: a frame is wider than it is
  // tall, so treating x and y as the same scale would make the spotlight an
  // ellipse that misses the fingers on one axis.
  const dx = ((maxX - minX) * w) / 2;
  const dy = ((maxY - minY) * h) / 2;
  const reach = Math.hypot(dx, dy) * (1 + SPOTLIGHT_PAD);
  return {
    x: (mirror ? 1 - cx : cx) * w,
    y: cy * h,
    r: Math.max(reach, Math.min(w, h) * SPOTLIGHT_MIN_R),
  };
}

// ---------------------------------------------------------------------------
// Camera capture layer (DOM). Grab frames, run the active tracking backend,
// ring-buffer the samples, and answer the one question main.ts asks: "the mic
// heard a strum at time T — which way?"
// ---------------------------------------------------------------------------

/// Analysis grid for the fallback backend. Tiny on purpose: at 64x48 a frame
/// diff is ~3k adds, and hand-scale motion survives heavy downscaling fine.
const GRID_W = 64;
const GRID_H = 48;
/// How much history the sample ring keeps, ms. Must comfortably exceed the
/// classify window plus scheduling slack.
const RING_MS = 5000;
/// The call for an onset is made this long after the onset, so the window has
/// its trailing samples. Latency is fine: this feeds a tally, not the highway.
const DECIDE_DELAY_MS = 160;

/// Where the build puts the MediaPipe assets (scripts/fetch-mediapipe.mjs —
/// they are fetched/copied at build time, not committed).
const MEDIAPIPE_WASM_BASE = "/mediapipe/wasm";
const HAND_MODEL_PATH = "/mediapipe/hand_landmarker.task";

export type StrumCamBackend = "hand" | "motion";

export interface StrumCamEvents {
  /// Every motion sample, for the live trace.
  onSample?: (s: MotionSample) => void;
  /// A direction call for a mic onset (fires DECIDE_DELAY_MS after the onset).
  onCall?: (call: StrumCall, onsetT: number) => void;
  /// A completed hand stroke; `ghost` = no mic onset anywhere near it. `audio` is
  /// how loud the strings were around it (peak flux ratio + window sample count),
  /// for measuring the silent-sweep vs quiet-strum boundary.
  onStroke?: (stroke: Stroke, ghost: boolean, audio: { peak: number; samples: number }) => void;
  /// The 21-point skeleton for every frame a hand is seen (hand backend only).
  /// This is the hook for hand graphics on other surfaces, e.g. the highway.
  onHand?: (hand: readonly HandPoint[], t: number) => void;
  /// Camera status line for the UI.
  onStatus?: (msg: string) => void;
}

export class StrumCam {
  /// Flip the up/down sense for rotated mounts. Applied at the sample source
  /// so the trace, calls and strokes all agree.
  flip = false;
  /// Which tracking backend is live. "hand" once the model loads; "motion"
  /// until then and whenever the model can't be used.
  backend: StrumCamBackend = "motion";
  /// Latest skeleton of the TRACKED (strumming) hand, in video coordinates
  /// (un-mirrored). Null when no hand is seen.
  lastHand: readonly HandPoint[] | null = null;
  /// Every other hand in frame — drawn faintly so the player can see that the app
  /// knows the fretting hand is there and has deliberately not locked onto it.
  /// Empty when only one hand is visible.
  otherHands: ReadonlyArray<readonly HandPoint[]> = [];
  /// What pickStrummingHand remembers between frames: the tracked hand's row plus
  /// every hand's row, so movement can be estimated. Null breaks the track.
  private track: HandTrack | null = null;
  fps = 0;

  private readonly events: StrumCamEvents;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly grab = document.createElement("canvas");
  private readonly grabCtx = this.grab.getContext("2d", { willReadFrequently: true })!;
  private preview: HTMLCanvasElement | null = null;
  private landmarker: HandLandmarker | null = null;
  private modelTried = false;
  private field = new MotionField(GRID_W, GRID_H);
  private hand = new HandMotion();
  private strokes = new StrokeTracker();
  private samples: MotionSample[] = [];
  private onsets: number[] = [];
  private flux: FluxSample[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private rafId = 0;
  private running = false;
  private frames = 0;
  private fpsAt = 0;

  constructor(events: StrumCamEvents = {}) {
    this.events = events;
    this.grab.width = GRID_W;
    this.grab.height = GRID_H;
  }

  get active(): boolean {
    return this.running;
  }

  /// The view's preview canvas; the capture loop paints the mirrored camera
  /// image plus the tracking overlay into it. Null detaches.
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

    this.events.onStatus?.("camera live · loading hand model…");
    await this.loadHandModel();

    this.field = new MotionField(GRID_W, GRID_H);
    this.hand = new HandMotion();
    this.strokes = new StrokeTracker();
    this.samples = [];
    this.onsets = [];
    this.flux = [];
    this.lastHand = null;
    this.otherHands = [];
    this.track = null;
    this.frames = 0;
    this.fpsAt = performance.now();
    this.running = true;
    this.events.onStatus?.(
      this.backend === "hand" ? "camera live · hand model" : "camera live · motion fallback (no hand model)"
    );
    this.tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.lastHand = null;
    this.otherHands = [];
    this.track = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.events.onStatus?.("camera off");
  }

  /// The mic heard a strum at `t` (performance.now() domain). Schedule a
  /// direction call once the trailing half of the window has been captured.
  /// Every audio window's flux ratio, whether or not it fired an onset. Kept so a
  /// stroke can be asked afterwards how loud the strings actually were — see
  /// fluxAroundStroke. Measurement only; nothing scores on this yet.
  noteFlux(t: number, ratio: number): void {
    if (!this.running) return;
    this.flux.push({ t, ratio });
    const cutoff = t - RING_MS;
    while (this.flux.length && this.flux[0].t < cutoff) this.flux.shift();
  }

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

  /// Load MediaPipe HandLandmarker once per app run. Every failure path lands
  /// on the frame-diff fallback — the lab must work on a machine that has
  /// never run scripts/fetch-mediapipe.mjs, just with the weaker signal.
  private async loadHandModel(): Promise<void> {
    if (this.landmarker) {
      this.backend = "hand";
      return;
    }
    if (this.modelTried) return; // failed before; don't re-pay the timeout
    this.modelTried = true;
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
      // GPU first (WebGL2 — present in WKWebView/WebView2), CPU as the retry:
      // some webviews expose WebGL2 but fail shader compilation.
      for (const delegate of ["GPU", "CPU"] as const) {
        try {
          this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate },
            runningMode: "VIDEO",
            // Both hands, so the strumming one can be CHOSEN. With numHands: 1 the
            // tracker returned whichever hand it found, and the moment the strumming
            // hand left frame it locked onto the fretting hand and kept reporting at
            // full confidence — see pickStrummingHand.
            numHands: 2,
          });
          break;
        } catch (e) {
          console.warn(`HandLandmarker ${delegate} init failed`, e);
        }
      }
    } catch (e) {
      console.warn("MediaPipe assets unavailable, using motion fallback", e);
    }
    this.backend = this.landmarker ? "hand" : "motion";
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

    this.frames++;
    if (t - this.fpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (t - this.fpsAt));
      this.frames = 0;
      this.fpsAt = t;
    }

    const raw = this.landmarker ? this.handFrame(video, t) : this.motionFrame(video, t);
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

  /// Hand backend: palm centroid of the STRUMMING hand, chosen from every hand in
  /// frame (see pickStrummingHand). Both hands are drawn; only one is tracked.
  private handFrame(video: HTMLVideoElement, t: number): MotionSample | null {
    let hand: readonly HandPoint[] | null = null;
    let score = 1;
    try {
      const res = this.landmarker!.detectForVideo(video, t);
      const found: HandCandidate[] = (res.landmarks ?? []).map((points, i) => ({
        points,
        label: res.handedness?.[i]?.[0]?.categoryName ?? "",
        score: res.handedness?.[i]?.[0]?.score ?? 1,
      }));
      this.otherHands = found.length > 1 ? found.map((h) => h.points) : [];
      const picked = pickStrummingHand(found, this.track);
      if (picked) {
        hand = picked.points;
        score = picked.score;
        this.track = {
          y: palmY(picked.points),
          rows: found.filter((h) => h.points.length >= 21).map((h) => palmY(h.points)),
        };
      } else {
        // Nothing usable: forget where we were, so a hand reappearing elsewhere
        // starts a fresh track instead of reading as one huge sweep.
        this.track = null;
      }
    } catch (e) {
      // A broken inference session won't heal; fall back for the rest of the run.
      console.warn("hand inference failed, switching to motion fallback", e);
      this.landmarker = null;
      this.backend = "motion";
      this.events.onStatus?.("camera live · motion fallback (hand model failed)");
      return this.motionFrame(video, t);
    }
    this.lastHand = hand;
    if (hand) this.events.onHand?.(hand, t);
    return this.hand.feed(hand ? palmY(hand) : null, t, score);
  }

  /// Fallback backend: frame differencing on a tiny luma grid.
  private motionFrame(video: HTMLVideoElement, t: number): MotionSample | null {
    this.grabCtx.drawImage(video, 0, 0, GRID_W, GRID_H);
    const rgba = this.grabCtx.getImageData(0, 0, GRID_W, GRID_H).data;
    const gray = new Uint8Array(GRID_W * GRID_H);
    for (let i = 0; i < gray.length; i++) {
      const j = i * 4;
      gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }
    return this.field.feed(gray, t);
  }

  private emitStroke(stroke: Stroke): void {
    // Ghost status can't be decided at stroke end: the matching onset may be
    // an audio-pipeline lag behind. Decide after the match window has passed.
    const timer = setTimeout(() => {
      if (!this.running) return;
      const ghost = !this.onsets.some(
        (o) => o >= stroke.t0 - GHOST_MATCH_MS && o <= stroke.t1 + GHOST_MATCH_MS
      );
      // Measurement rides along: how loud the strings were around this stroke,
      // whether or not an onset fired. Nothing scores on it — it exists so the
      // silent-sweep vs quiet-strum threshold can be chosen from real numbers
      // instead of guessed at.
      this.events.onStroke?.(stroke, ghost, fluxAroundStroke(this.flux, stroke));
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

    // When a hand is tracked, dim the frame and leave the hand lit, so the
    // player can see at a glance WHAT the tracker has locked onto — the single
    // most useful thing this preview can tell them. A wall, a face or a passing
    // arm being spotlit instead of the strumming hand explains a whole run of
    // bad calls, and is otherwise invisible behind a plausible-looking skeleton.
    const spot = this.lastHand ? spotlightFor(this.lastHand, width, height) : null;
    if (spot) {
      // Darken everything, then cut the spotlight back out. `destination-out`
      // erases the dim layer rather than painting light over the image, so the
      // hand keeps its true colours instead of being washed toward white.
      ctx.save();
      ctx.fillStyle = `rgba(3, 8, 8, ${DIM_ALPHA})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "destination-out";
      // A soft edge: a hard circle reads as a porthole cut out of the picture,
      // which draws the eye to the rim instead of the hand.
      const hole = ctx.createRadialGradient(spot.x, spot.y, spot.r * 0.55, spot.x, spot.y, spot.r);
      hole.addColorStop(0, "rgba(0,0,0,1)");
      hole.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = hole;
      ctx.beginPath();
      ctx.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Untracked hands (the fretting hand) in outline only, under the spotlit one.
    // Drawn at all so the player can see the app KNOWS the other hand is there and
    // has deliberately not locked onto it — when direction calls look wrong, "it's
    // watching the wrong hand" is the first thing worth ruling out, and an unmarked
    // hand makes that invisible.
    for (const other of this.otherHands) {
      if (other === this.lastHand) continue;
      drawHand(ctx, other, width, height, {
        color: "rgba(120, 132, 146, 0.30)",
        jointColor: "rgba(120, 132, 146, 0.22)",
        lineWidth: 1.5,
      });
    }

    // Overlays are drawn in video pixel space (un-flip a flipped sample).
    if (this.lastHand) {
      // Two passes for the glow: a wide, soft, low-alpha stroke under a crisp
      // one. canvas shadowBlur alone would bleed the joint dots into a smear at
      // this scale, and it is markedly slower per frame at 30fps.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      drawHand(ctx, this.lastHand, width, height, {
        color: "rgba(25, 227, 196, 0.22)",
        jointColor: "rgba(25, 227, 196, 0.18)",
        lineWidth: 9,
      });
      ctx.restore();
      drawHand(ctx, this.lastHand, width, height);
    }
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
