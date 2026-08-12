// The single camera, shared by everything that wants it.
//
// The StrumCam analyser used to be owned by its lab view, with callbacks wired
// straight into that view's DOM. That was right while the camera only fed the lab.
// Practice scoring needs the same stream, and a second `StrumCam` would mean a
// second `getUserMedia`, a second hand model, and two views fighting over one
// device — so the instance moves here and its events fan out to any number of
// subscribers.
//
// This module also owns the one piece of state the scorer needs and the analyser
// doesn't: a timestamped ring of recent strokes. A ghost is only knowable ~340ms
// after the stroke ends (it is DEFINED by a mic onset failing to arrive), so the
// fact lands well after the bar it belongs to has been sealed. Pushing strokes into
// the open bar as they arrive would therefore attribute the late ones to the wrong
// bar, or drop them. Instead the session asks, at seal time, for the strokes whose
// timestamps fall inside the bar's own window — see `strokesInBar` in verdict.ts.

import { StrumCam, type HandPoint, type MotionSample, type Stroke, type StrumCall } from "./strumcam.ts";
import type { CameraStroke } from "./verdict.ts";

/// Long enough to cover a sealed bar plus the ~340ms a ghost takes to resolve,
/// with room for a slow tempo. At 60bpm a 4/4 bar is 4s, so this holds the current
/// bar and the one before it.
const STROKE_RING_MS = 12_000;

export interface StrumCamSubscriber {
  onSample?: (s: MotionSample) => void;
  onCall?: (call: StrumCall, onsetT: number) => void;
  onStroke?: (stroke: Stroke, ghost: boolean) => void;
  onHand?: (hand: readonly HandPoint[], t: number) => void;
  onStatus?: (msg: string) => void;
}

const subscribers = new Set<StrumCamSubscriber>();

/// Every stroke the camera has resolved recently, oldest first. Read by the
/// scorer at seal time rather than pushed at it, because of the arrival lag above.
const strokeRing: CameraStroke[] = [];

/// Fan an event out to every subscriber. A throwing subscriber must not stop the
/// others or kill the capture loop: the lab view and the practice screen are
/// independent, and a DOM error in one is not a reason for the camera to stop
/// feeding the other.
function fan<K extends keyof StrumCamSubscriber>(
  key: K,
  call: (s: NonNullable<StrumCamSubscriber[K]>) => void
): void {
  for (const sub of subscribers) {
    const handler = sub[key];
    if (!handler) continue;
    try {
      call(handler as NonNullable<StrumCamSubscriber[K]>);
    } catch (e) {
      console.error(`strumcam subscriber threw on ${String(key)}`, e);
    }
  }
}

export const strumcam = new StrumCam({
  onSample: (s) => fan("onSample", (h) => h(s)),
  onCall: (call, onsetT) => fan("onCall", (h) => h(call, onsetT)),
  onStroke: (stroke, ghost) => {
    // Midpoint, not t0: a sweep that straddles a bar line has to be assigned to
    // one bar, and the middle is the least arbitrary choice.
    strokeRing.push({ t: (stroke.t0 + stroke.t1) / 2, dir: stroke.dir, ghost });
    const cutoff = stroke.t1 - STROKE_RING_MS;
    while (strokeRing.length && strokeRing[0].t < cutoff) strokeRing.shift();
    fan("onStroke", (h) => h(stroke, ghost));
  },
  onHand: (hand, t) => fan("onHand", (h) => h(hand, t)),
  onStatus: (msg) => fan("onStatus", (h) => h(msg)),
});

export function subscribeStrumCam(sub: StrumCamSubscriber): () => void {
  subscribers.add(sub);
  return () => subscribers.delete(sub);
}

/// Every recently resolved stroke, for the scorer to window by bar.
export function recentStrokes(): readonly CameraStroke[] {
  return strokeRing;
}

/// Forget the buffered strokes. Called when scoring resets (song load, restart) so
/// the first bar of a new attempt can't inherit sweeps from the last one.
export function clearStrokes(): void {
  strokeRing.length = 0;
}

export function cameraActive(): boolean {
  return strumcam.active;
}

/// Tell the analyser the mic heard a strum. Fed from the single `chord` listener
/// in main.ts; a no-op while the camera is off.
export function noteCameraOnset(t: number): void {
  if (strumcam.active) strumcam.noteOnset(t);
}

/// Start the camera, or stop it. Returns whether it ended up running, so a caller
/// can reflect the real state rather than the state it asked for — a denied
/// permission prompt must not leave a lit toggle.
export async function setCameraActive(on: boolean): Promise<boolean> {
  if (on === strumcam.active) return strumcam.active;
  if (on) {
    try {
      await strumcam.start();
    } catch (e) {
      // start() already reports the reason through onStatus; subscribers show it.
      console.error("camera start failed", e);
    }
  } else {
    strumcam.stop();
    clearStrokes();
  }
  return strumcam.active;
}
