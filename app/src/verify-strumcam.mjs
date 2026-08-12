// Checks the StrumCam analysis core in strumcam.ts: the frame-difference
// motion tracker, the direction call made at a mic onset, and the stroke
// segmenter that finds ghost strokes.
//
// The camera path can't be exercised without a camera, but everything that
// DECIDES lives in the pure core, and a wrong direction call is the failure
// mode that matters — it would teach a player the opposite of what their hand
// did. These checks drive the core with synthetic frames whose true motion is
// known: a bright bar sweeping down or up a black frame at a known speed.
//
// Run with `pnpm verify:strumcam`. Plain node, no dependencies — it imports
// strumcam.ts directly (node strips types natively) so it tests the real code.

import {
  HandMotion,
  MotionField,
  StrokeTracker,
  classifyStrum,
  palmY,
  pickStrummingHand,
  spotlightFor,
} from "./strumcam.ts";

let failures = 0;

function check(name, cond, detail = "") {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- synthetic frames -------------------------------------------------------

const W = 32;
const H = 24;

/// A black frame with a bright horizontal bar (the "hand") at row `y`.
function frame(y, brightness = 200, barRows = 3) {
  const g = new Uint8Array(W * H);
  for (let r = Math.max(0, Math.round(y)); r < Math.min(H, Math.round(y) + barRows); r++) {
    g.fill(brightness, r * W, r * W + W);
  }
  return g;
}

/// Sweep the bar from row y0 to row y1 over `n` frames, dt ms apart, feeding
/// `field` and collecting the samples. Returns { samples, t } where t is the
/// timestamp after the last frame.
function sweep(field, y0, y1, n, dt, t0) {
  const samples = [];
  let t = t0;
  for (let i = 0; i < n; i++) {
    const y = y0 + ((y1 - y0) * i) / (n - 1);
    const s = field.feed(frame(y), t);
    if (s) samples.push(s);
    t += dt;
  }
  return { samples, t };
}

// --- MotionField ------------------------------------------------------------

console.log("MotionField");
{
  const field = new MotionField(W, H);
  // 2..18 over 9 frames @ 20ms: 16 rows in 160ms ≈ 4.2 frame-heights/sec down.
  const { samples } = sweep(field, 2, 18, 9, 20, 1000);
  check("a down sweep produces samples", samples.length >= 5, `got ${samples.length}`);
  check(
    "every velocity in a down sweep is positive (down)",
    samples.every((s) => s.v > 0),
    JSON.stringify(samples.map((s) => +s.v.toFixed(2)))
  );
  const settled = samples[samples.length - 1].v;
  check("speed is in the right ballpark", settled > 2 && settled < 7, `settled ${settled}`);
  check("centroid moves down the frame", samples[samples.length - 1].y > samples[0].y);
}
{
  const field = new MotionField(W, H);
  const { samples } = sweep(field, 18, 2, 9, 20, 1000);
  check(
    "an up sweep is negative everywhere",
    samples.length >= 5 && samples.every((s) => s.v < 0),
    JSON.stringify(samples.map((s) => +s.v.toFixed(2)))
  );
}
{
  const field = new MotionField(W, H);
  let still = 0;
  for (let i = 0; i < 10; i++) if (field.feed(frame(10), 1000 + i * 20)) still++;
  check("a still scene produces no samples", still === 0, `got ${still}`);
}
{
  // Motion, a long pause, then motion elsewhere: the pause must break the
  // velocity chain — otherwise the jump reads as one huge fake sweep.
  const field = new MotionField(W, H);
  sweep(field, 2, 8, 5, 20, 1000);
  for (let i = 0; i < 10; i++) field.feed(frame(8), 1100 + i * 20);
  const after = field.feed(frame(20), 1300);
  check("motion after a still gap restarts cleanly (no sample yet)", after === null);
}

// --- HandMotion (the hand-landmark backend's position→velocity adapter) -----

console.log("HandMotion");
{
  // Palm sweeping down the frame: 0.2 → 0.8 over 9 frames @ 20ms ≈ 3.75 h/s.
  const hm = new HandMotion();
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const s = hm.feed(0.2 + (0.6 * i) / 8, 1000 + i * 20, 0.95);
    if (s) samples.push(s);
  }
  check("a palm sweep down produces positive samples", samples.length >= 6 && samples.every((s) => s.v > 0), JSON.stringify(samples.map((s) => +s.v.toFixed(2))));
  const call = classifyStrum(samples, 1080);
  check("hand-backend sweep classifies down", call.dir === "down", JSON.stringify(call));
}
{
  // The hand leaves the frame mid-motion and reappears somewhere else: the
  // gap must break the velocity chain, not read as a giant sweep.
  const hm = new HandMotion();
  for (let i = 0; i < 5; i++) hm.feed(0.3 + i * 0.05, 1000 + i * 20, 0.95);
  for (let i = 0; i < 5; i++) hm.feed(null, 1100 + i * 20, 0);
  const reappeared = hm.feed(0.9, 1200, 0.95);
  check("a tracking gap breaks the chain (no sample on reappearance)", reappeared === null);
}
{
  // Low-score detections are "no hand", not weak evidence of position.
  const hm = new HandMotion();
  hm.feed(0.3, 1000, 0.95);
  hm.feed(0.5, 1020, 0.2); // garbage detection mid-chain
  const next = hm.feed(0.35, 1040, 0.95);
  check("a low-score frame resets rather than feeds", next === null);
}
{
  // palmY is the mean of wrist + the four knuckles, ignoring fingertips.
  const hand = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9 }));
  for (const i of [0, 5, 9, 13, 17]) hand[i] = { x: 0.5, y: 0.4 };
  check("palmY reads the palm, not the fingers", Math.abs(palmY(hand) - 0.4) < 1e-9, `got ${palmY(hand)}`);
}

// --- classifyStrum ----------------------------------------------------------

console.log("classifyStrum");
{
  const field = new MotionField(W, H);
  const { samples } = sweep(field, 2, 18, 9, 20, 1000);
  const call = classifyStrum(samples, 1080); // onset mid-sweep
  check("down sweep at the onset -> down", call.dir === "down", JSON.stringify(call));
  check("a clean sweep is consistent", call.consistency > 0.9, `consistency ${call.consistency}`);
}
{
  const field = new MotionField(W, H);
  const { samples } = sweep(field, 18, 2, 9, 20, 1000);
  const call = classifyStrum(samples, 1080);
  check("up sweep at the onset -> up", call.dir === "up", JSON.stringify(call));
}
{
  const call = classifyStrum([], 1080);
  check("no samples -> unknown, with the reason", call.dir === "unknown" && call.reason === "no motion in frame", JSON.stringify(call));
}
{
  const field = new MotionField(W, H);
  const { samples } = sweep(field, 2, 18, 9, 20, 1000);
  const call = classifyStrum(samples, 5000); // onset nowhere near the motion
  check("onset far from any motion -> unknown", call.dir === "unknown", JSON.stringify(call));
}
{
  // A hand hovering with a tremor: alternating ±1-row jitter. Whatever tiny
  // mean survives the sign flips must not be called a direction.
  const field = new MotionField(W, H);
  const samples = [];
  for (let i = 0; i < 16; i++) {
    const s = field.feed(frame(10 + (i % 2)), 1000 + i * 20);
    if (s) samples.push(s);
  }
  const call = classifyStrum(samples, 1160);
  check("jitter -> unknown, not a coin flip", call.dir === "unknown", JSON.stringify(call));
}
{
  // Direction is decided by motion AT the onset, not by the biggest motion in
  // history: a down sweep, a beat of stillness, then the onset during a clear
  // up sweep must read UP.
  const field = new MotionField(W, H);
  const a = sweep(field, 2, 18, 9, 20, 1000);
  for (let i = 0; i < 8; i++) field.feed(frame(18), a.t + i * 20);
  const b = sweep(field, 18, 2, 9, 20, a.t + 200);
  const call = classifyStrum([...a.samples, ...b.samples], a.t + 200 + 80);
  check("the window picks the sweep under the onset", call.dir === "up", JSON.stringify(call));
}

// --- StrokeTracker ----------------------------------------------------------

console.log("StrokeTracker");
function playSamples(tracker, samples) {
  const strokes = [];
  for (const s of samples) {
    const done = tracker.feed(s);
    if (done) strokes.push(done);
  }
  const tail = tracker.flush();
  if (tail) strokes.push(tail);
  return strokes;
}
{
  const field = new MotionField(W, H);
  const { samples } = sweep(field, 2, 18, 9, 20, 1000);
  const strokes = playSamples(new StrokeTracker(), samples);
  check("one down sweep -> one down stroke", strokes.length === 1 && strokes[0].dir === "down", JSON.stringify(strokes));
}
{
  // Down sweep, pause, up sweep -> exactly two strokes in order.
  const field = new MotionField(W, H);
  const a = sweep(field, 2, 18, 9, 20, 1000);
  for (let i = 0; i < 8; i++) field.feed(frame(18), a.t + i * 20);
  const b = sweep(field, 18, 2, 9, 20, a.t + 200);
  const strokes = playSamples(new StrokeTracker(), [...a.samples, ...b.samples]);
  check(
    "down then up -> two strokes, in order",
    strokes.length === 2 && strokes[0].dir === "down" && strokes[1].dir === "up",
    JSON.stringify(strokes)
  );
  check("strokes don't overlap", strokes.length === 2 && strokes[0].t1 <= strokes[1].t0);
}
{
  // A single-frame twitch is not a stroke.
  const field = new MotionField(W, H);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const s = field.feed(frame(i === 3 ? 14 : 10), 1000 + i * 20);
    if (s) samples.push(s);
  }
  const strokes = playSamples(new StrokeTracker(), samples);
  check("a twitch is not a stroke", strokes.length === 0, JSON.stringify(strokes));
}

// --- spotlight geometry -----------------------------------------------------
//
// The preview dims the frame and lights the tracked hand, so the player can see
// WHAT the tracker locked onto. That only helps if the lit circle actually lands
// on the hand: a spotlight on the wrong thing, or one that mirrors the wrong way,
// would reassure the player at exactly the moment they should be suspicious.

/// A 21-point hand filling a box, in normalized coords.
function handIn(x0, y0, x1, y1) {
  const pts = [];
  for (let i = 0; i < 21; i++) {
    // Spread the points over the box; corners included so the bounds are exact.
    const fx = i % 2 === 0 ? 0 : 1;
    const fy = i < 2 ? 0 : i > 18 ? 1 : (i % 5) / 4;
    pts.push({ x: x0 + (x1 - x0) * fx, y: y0 + (y1 - y0) * fy });
  }
  pts[0] = { x: x0, y: y0 };
  pts[20] = { x: x1, y: y1 };
  return pts;
}

{
  check("fewer than 21 points yields no spotlight", spotlightFor([{ x: 0.5, y: 0.5 }], 640, 480) === null);
}
{
  // Un-mirrored, a hand on the left of the frame lights the left of the frame.
  const s = spotlightFor(handIn(0.1, 0.4, 0.3, 0.6), 640, 480, false);
  check("spotlight centres on the hand (x)", Math.abs(s.x - 0.2 * 640) < 1, JSON.stringify(s));
  check("spotlight centres on the hand (y)", Math.abs(s.y - 0.5 * 480) < 1, JSON.stringify(s));
}
{
  // Mirrored (the default, matching drawHand): a hand on the LEFT of the raw
  // video is drawn on the RIGHT of the preview, and the spotlight must follow
  // the skeleton rather than the raw coordinates.
  const hand = handIn(0.1, 0.4, 0.3, 0.6);
  const m = spotlightFor(hand, 640, 480, true);
  const u = spotlightFor(hand, 640, 480, false);
  check("mirroring flips the spotlight across the frame", Math.abs(m.x - (640 - u.x)) < 1, JSON.stringify({ m, u }));
  check("mirroring leaves y alone", Math.abs(m.y - u.y) < 1e-9);
}
{
  // The radius must cover the hand it is lighting, measured in PIXELS. A wide
  // flat hand is the case that separates a pixel-space radius from a normalized
  // one: normalized units make a frame-spanning hand read as 0.5 "wide", which
  // the minimum-radius floor then silently rounds up to a circle far too small
  // to cover it. Sized deliberately so the floor cannot mask the difference.
  const w = 640;
  const h = 480;
  const hand = handIn(0.15, 0.45, 0.85, 0.55);
  const s = spotlightFor(hand, w, h, false);
  const halfDiag = Math.hypot(((0.85 - 0.15) * w) / 2, ((0.55 - 0.45) * h) / 2);
  check("spotlight reaches past the hand's extent", s.r > halfDiag, `${s.r} vs ${halfDiag}`);
  // Every landmark is inside the lit circle.
  const covered = hand.every((p) => Math.hypot(p.x * w - s.x, p.y * h - s.y) <= s.r);
  check("every landmark is inside the spotlight", covered, JSON.stringify(s));
}
{
  // A distant hand covers few pixels; without a floor the spotlight would shrink
  // to a dot and defeat the purpose.
  const tiny = spotlightFor(handIn(0.5, 0.5, 0.505, 0.505), 640, 480, false);
  check("a tiny hand still gets a visible spotlight", tiny.r >= Math.min(640, 480) * 0.12, JSON.stringify(tiny));
}
{
  // A hand spanning the frame gets a spotlight larger than the floor — the floor
  // is a minimum, not a cap.
  const big = spotlightFor(handIn(0.05, 0.05, 0.95, 0.95), 640, 480, false);
  const small = spotlightFor(handIn(0.45, 0.45, 0.55, 0.55), 640, 480, false);
  check("the spotlight scales with the hand", big.r > small.r, JSON.stringify({ big, small }));
}

// --- picking the strumming hand ---------------------------------------------
//
// The tracker used to run with numHands: 1 and take whatever it found. When the
// strumming hand left frame it locked onto the FRETTING hand and kept reporting at
// full confidence — worse than losing the track, because the fretting hand slides
// along the neck and so produces real vertical velocity. Every direction call
// stayed confident while describing the wrong hand.
//
// The pick is behavioural, not label-based: handedness labels are mirrored, players
// strum with either hand, and a rotated mount flips the sense again, so any fixed
// left/right rule would track the wrong hand for someone.

console.log("pickStrummingHand");

/// A hand candidate centred on row `y`.
function candidate(y, score = 0.9) {
  return { points: handIn(0.4, y - 0.05, 0.6, y + 0.05), label: "", score };
}

{
  check("no hands -> no pick", pickStrummingHand([], null) === null);
  check(
    "a hand with too few landmarks is not usable",
    pickStrummingHand([{ points: [{ x: 0.5, y: 0.5 }], label: "", score: 1 }], null) === null
  );
}
{
  const only = candidate(0.5);
  check("a single hand is taken regardless of history", pickStrummingHand([only], null) === only);
}
{
  // The case that caused the bug: two hands, and an established track. The pick must
  // follow the hand it was already on, NOT whichever is more prominent.
  const tracked = candidate(0.62);
  const fretting = candidate(0.30, 0.99); // higher score, deliberately
  const picked = pickStrummingHand([fretting, tracked], 0.6);
  check("an established track wins over a more confident stranger", picked === tracked, JSON.stringify(palmY(picked.points)));
}
{
  // Continuity holds through a normal strum step. At 30fps a fast strum moves ~0.1
  // frame-heights per frame.
  let prev = 0.40;
  const rows = [0.50, 0.60, 0.68, 0.58, 0.46];
  const fretting = candidate(0.20, 0.99);
  let followed = true;
  for (const y of rows) {
    const strumming = candidate(y);
    const picked = pickStrummingHand([fretting, strumming], prev);
    if (picked !== strumming) followed = false;
    prev = palmY(picked.points);
  }
  check("the track follows a strumming hand across a full sweep", followed, `ended at ${prev}`);
}
{
  // With no history, prefer the more confident detection — there is nothing better
  // to go on, and it must be deterministic rather than "whichever came first".
  const weak = candidate(0.7, 0.55);
  const strong = candidate(0.3, 0.95);
  check("no history -> the more confident hand", pickStrummingHand([weak, strong], null) === strong);
  check("...and the order of the input doesn't change it", pickStrummingHand([strong, weak], null) === strong);
}
{
  // Equal scores with no history must still be stable frame to frame, or the pick
  // oscillates and every switch resets the velocity chain.
  const a = candidate(0.3, 0.9);
  const b = candidate(0.7, 0.9);
  check("an exact tie resolves the same way both orders", pickStrummingHand([a, b], null) === pickStrummingHand([b, a], null));
}
{
  // A near-tie in distance must NOT be resolved by distance: crossing hands would
  // flip the pick mid-strum. Falls through to the score rule instead.
  const left = candidate(0.48, 0.6);
  const right = candidate(0.52, 0.95);
  const picked = pickStrummingHand([left, right], 0.5);
  check("hands equally close to the last position fall back to confidence", picked === right);
}
{
  // A hand that teleports (out of frame and back elsewhere) must not be claimed as
  // the same track — that is what produced fake giant sweeps before.
  const far = candidate(0.95);
  const other = candidate(0.10, 0.99);
  const picked = pickStrummingHand([far, other], 0.5);
  check("no candidate within one frame's travel -> fall back to confidence", picked === other);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall strumcam checks passed");
