// ---- iOS audio-session interruptions and route changes ----
// A phone call, Siri, or another app taking the session kills our streams and
// iOS does not hand them back. The native observer re-activates the session and
// tells us; only the frontend knows what the user was doing, so resuming is our
// job. Nothing fires on desktop.
//
// Playback does NOT auto-resume: having a backing track burst out of the
// speaker the instant you hang up is worse than pressing play yourself. The
// transport pauses and the mic — passive — comes back on its own.

import { nativeInvoke, onNative, type AudioInterruption, type AudioRouteChange } from "./native.ts";
import { isPlaying, stopTransport } from "./session.ts";
import { isTunerListening, startTunerListening, stopTunerListening } from "./views/tuner.ts";

export interface IosAudioDeps {
  /// Is the chord detector running? Captured so it can be put back.
  isChordListening: () => boolean;
  /// Drop chord-detector state and reset its button. The stream is already
  /// dead — this only stops the UI from lying about it.
  stopChordListening: () => void;
  /// Bring the chord detector back up, re-arming the current target.
  startChordListening: () => Promise<void>;
  /// Say something in the coach line — the only place the player will look.
  setCoachMessage: (text: string) => void;
  markDisconnected: () => void;
  syncKeepAwake: () => void;
  onPracticeStateChanged: () => void;
}

let deps: IosAudioDeps;
let wasListeningBeforeInterruption = false;
let wasChordListeningBeforeInterruption = false;

export function initIosAudio(d: IosAudioDeps): void {
  deps = d;

  onNative<AudioInterruption>("audio_interruption", async ({ began }) => {
    if (began) {
      wasListeningBeforeInterruption = isTunerListening();
      wasChordListeningBeforeInterruption = deps.isChordListening();
      // The streams are already dead; drop our own state so the buttons and the
      // "live" dot don't lie, and pause the transport so we don't silently run
      // the playhead past the whole song while the audio is gone.
      stopTunerListening();
      deps.stopChordListening();
      deps.markDisconnected();
      if (isPlaying()) stopTransport();
      await nativeInvoke("stop_audio").catch(() => {});
      deps.syncKeepAwake();
      deps.setCoachMessage("audio interrupted — resuming when the call ends");
      deps.onPracticeStateChanged();
      return;
    }

    // Interruption over: the native side has re-activated the session, so put
    // the mic back exactly where it was.
    try {
      if (wasChordListeningBeforeInterruption) {
        await deps.startChordListening();
      } else if (wasListeningBeforeInterruption) {
        await startTunerListening();
      }
      if (deps.isChordListening() || isTunerListening()) deps.setCoachMessage("");
    } catch (e) {
      deps.setCoachMessage(`mic didn't come back: ${e} — press Start listening`);
    }
    wasListeningBeforeInterruption = false;
    wasChordListeningBeforeInterruption = false;
    deps.markDisconnected();
    deps.syncKeepAwake();
    deps.onPracticeStateChanged();
  });

  // Headphones pulled out (reason 2 = old device unavailable). Apple's guidance
  // is to pause rather than blast the built-in speaker; the mic keeps going since
  // the native side has already re-routed it.
  onNative<AudioRouteChange>("audio_route_change", ({ reason }) => {
    if (reason !== 2) return;
    if (isPlaying()) {
      stopTransport();
      deps.setCoachMessage("output device disconnected — playback paused");
    }
    deps.onPracticeStateChanged();
  });
}
