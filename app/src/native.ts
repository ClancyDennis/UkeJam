// The Tauri boundary: invoking Rust commands, and receiving its event stream.
//
// Everything the Rust side emits arrives here and nowhere else. Views subscribe
// through `onNative`, which opens exactly one underlying subscription per event
// name no matter how many listeners join. That single-subscription rule is not
// cosmetic: the audio events drive song advance and bar scoring, so a duplicate
// listener on "chord" would advance the song twice per reading and seal bars in
// pairs.
//
// In a browser (vite dev without Tauri) there is no native runtime: invokes
// reject and listens resolve to a no-op unsubscribe, so the UI still loads.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export const nativeRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function nativeInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!nativeRuntime) return Promise.reject("native runtime unavailable");
  return tauriInvoke<T>(command, args);
}

export function nativeListen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<() => void> {
  if (!nativeRuntime) return Promise.resolve(() => {});
  return tauriListen<T>(event, handler as any).catch((e) => {
    console.warn(`native event '${event}' unavailable`, e);
    return () => {};
  });
}

// --- event bus ---

type NativeHandler<T> = (payload: T) => void;

const busSubscribers = new Map<string, Set<NativeHandler<any>>>();

/// Subscribe to a Rust event. The first subscriber for a given event name opens
/// the one and only native subscription for it; later subscribers just join the
/// set. Returns an unsubscribe function.
export function onNative<T>(event: string, handler: NativeHandler<T>): () => void {
  let set = busSubscribers.get(event);
  if (!set) {
    set = new Set();
    busSubscribers.set(event, set);
    void nativeListen<T>(event, (e) => {
      // Iterate a copy: a handler is allowed to unsubscribe itself (or another)
      // while the event is being dispatched.
      for (const h of [...(busSubscribers.get(event) ?? [])]) h(e.payload);
    });
  }
  set.add(handler);
  return () => {
    busSubscribers.get(event)?.delete(handler);
  };
}

// --- event payloads (the Rust contract; see audio.rs and backing.rs) ---

export interface TunerReading {
  active: boolean;
  freq: number;
  nearest: string;
  cents: number;
  rms: number;
}

export interface ChordReading {
  active: boolean;
  detected: string;
  cleanliness: number;
  chroma: number[];
  spectrum: number[];
  missing: string[];
  extra: string[];
  rms: number;
  // An attack (strum/pluck) began since the last reading. Latched on the Rust
  // side across coalesced emits, so it is safe to treat every `true` as one
  // strum — see ChordReading::onset in audio.rs.
  onset: boolean;
  // Spectral flux as a multiple of its slow baseline (1.0 = steady state).
  flux: number;
  // How long ago the strum this reading reports actually happened, in ms
  // (detection-to-emit coalescing + the mic's capture latency). 0 when
  // `onset` is false. Subtract from the arrival time before grading timing.
  onsetAgeMs: number;
}

export interface BackingStatus {
  playing: boolean;
  // Samples rendered so far, in seconds. This RUNS AHEAD of what the speaker
  // is playing by `latency` — subtract it to get the audible position.
  pos: number;
  length: number;
  loaded: boolean;
  // Output pipeline latency in seconds (0 when the host can't report it).
  latency: number;
}

export interface AudioInterruption {
  began: boolean;
}

export interface AudioRouteChange {
  reason: number;
}

export interface SoundfontProgress {
  received: number;
  total: number;
}
