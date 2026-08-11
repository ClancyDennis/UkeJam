// Which screen is on show.
//
// A plain store rather than an event bus: the render loops poll it every frame
// to decide whether to paint at all, and the views that care about entering or
// leaving a screen are driven explicitly by the router in main.ts, where the
// cross-cutting policy lives (stop the mic when leaving a practice surface,
// stop the camera when leaving StrumCam).

export type AppMode = "tuner" | "play" | "arrangement" | "cal-mic" | "library" | "strumcam";

// Play is home; Tune, Setup, Library and StrumCam are the screens you visit.
let mode: AppMode = "play";

export function currentMode(): AppMode {
  return mode;
}

export function setMode(m: AppMode): void {
  mode = m;
}

/// The two practice surfaces. Moving between them keeps transport, backing and
/// listening state alive — they are the same session seen two ways.
export function isPracticeMode(m: AppMode): boolean {
  return m === "play" || m === "arrangement";
}
