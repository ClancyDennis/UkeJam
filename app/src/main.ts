// UkeJam bootstrap.
//
// Everything here is wiring: bind the modules in dependency order, route the
// mode buttons, and fan the Rust event stream out to whoever needs it. The
// screens live under views/, the practice state machine in session.ts, and the
// pure logic in theory/ and time.ts — none of which import this file.
//
// Two things stay here on purpose. loadSongIntoPlay rebuilds every practice
// view and switches screen, and cycleChordShape spans the Play rail and the
// arrangement cards; both are orchestration across modules that should not
// know about each other.

import { nativeInvoke, onNative, type BackingStatus, type ChordReading } from "./native";
import { getSong, type SongRecord } from "./library";
import { activeTuning } from "./tunings";
import {
  hideSoundfontOpenFolder,
  initSoundfont,
} from "./views/setup/soundfont";
import { aiConfig, initAiSettings, renderAiPanel, setAiStatus } from "./views/setup/aiSettings";
import { initOpenRouterAuth, resumeOpenRouterLogin } from "./views/setup/openrouterAuth";
import { initIosAudio } from "./iosAudio";
import { initGauge, } from "./views/play/gauge";
import { buildSongStrip, initStrip, updateStrip } from "./views/play/strip";
import { buildLyrics, initLyrics, updateLyrics } from "./views/play/lyrics";
import { initHighway } from "./views/play/highway";
import { initChroma } from "./views/play/chroma";
import {
  initPlayView,
  isChordListening,
  noteOnset,
  setChordListening,
  setCoachMessage,
  startChordListening,
  stopChordListening,
  updatePracticeUi,
} from "./views/play/index";
import { initBreakdown, } from "./views/play/breakdown";
import {
  initTransport,
  setBackingControlsVisible,
  setPlayButtons,
  setTimeReadout,
  setTimingReadout,
} from "./views/play/transport";
import {
  initLibraryView,
  renderSongList,
  setLibraryStatus,
} from "./views/libraryView";
import {
  buildArrangement,
  initArrangement,
  redrawArrangementChordCards,
  updateArrangementState,
} from "./views/arrangement";
import {
  initFretboard,
  invalidateFretboards,
  updateTransitionCoach,
} from "./views/play/fretboard";
import {
  initCoach,
  onBarSealed,
  requestCoaching,
  resetCoachBarCount,
  resetCoaching,
} from "./views/play/coach";
import {
  initFft,
} from "./views/play/fft";
import {
  accumulateReading,
  buildSectionMap,
  currentSong,
  hasBackingAudio,
  initSession,
  isPlaying,
  isTimed,
  loadBackingIntoEngine,
  maybeAdvance,
  resetScoring,
  setLoadedSong,
  setTarget,
  setupBacking,
  setupTiming,
  stopTransport,
  syncBackingPos,
} from "./session";

import { currentMode, isPracticeMode, setMode, type AppMode } from "./state/appMode";
import {
  initTuner,
  isTunerListening,
  noteTunerRms,
  rebuildStringRows,
  stopTunerListening,
} from "./views/tuner";
import { initTuningSetup } from "./views/setup/tuningSetup";
import { initStrumCam, stopStrumcamSession, strumcamOnset } from "./views/strumcamView";
import { noteCameraFlux, noteCameraOnset } from "./strumcamShared";
import {
  cycleShapeChoice,
  resetVoicingsForTuningChange,
} from "./theory/voicings";


const connEl = document.querySelector(".conn") as HTMLElement;
const connText = document.getElementById("conn-text")!;

/// The one "is the mic actually feeding us" indicator, shared by the tuner and
/// the practice screens.
function setConn(live: boolean) {
  connEl.classList.toggle("live", live);
  connText.textContent = live ? "live" : isTunerListening() ? "listening…" : "idle";
}

// --- keep the screen awake while the app is actually in use ---
// On iOS the idle timer would lock the screen mid-song: you play for minutes
// without touching the glass. Anything that changes tuner listening,
// `chordListening` or `playing` calls this, and the native side is only poked
// when the combined state flips (setIdleTimerDisabled is a main-thread hop).
let keepAwake = false;
function syncKeepAwake() {
  const want = isTunerListening() || isChordListening() || isPlaying();
  if (want === keepAwake) return;
  keepAwake = want;
  nativeInvoke("set_keep_awake", { awake: want }).catch(() => {});
}

initTuner({ setConn, syncKeepAwake });
initGauge();
initFft();
initCoach();
initStrip();
initLyrics();
initHighway();
initFretboard({ cycleChordShape, isChordListening });
initArrangement({ cycleChordShape });
initLibraryView({ loadSongIntoPlay });
initTransport({
  onPracticeStateChanged: updatePracticeUi,
  onCameraUnavailable: () =>
    setCoachMessage("couldn't open the camera — check the camera permission, then tap ◉ hand again"),
});
initChroma();
initBreakdown();
initPlayView({
  currentReading: () => chord,
  lastReadingAt: () => lastChordAt,
  setConn,
  syncKeepAwake,
  clearReading: () => {
    chord = null;
  },
});


// --- view navigation (Play is home; Tune, Setup, Library, StrumCam are the
// screens you visit) ---
const tunerView = document.getElementById("tuner-view")!;
const playView = document.getElementById("play-view")!;
const arrangementView = document.getElementById("arrangement-view")!;
const setupView = document.getElementById("setup-view")!;
const libraryView = document.getElementById("library-view")!;
const strumcamView = document.getElementById("strumcam-view")!;
const cornerLabel = document.getElementById("corner-label")!;
// any element with data-mode navigates (util buttons + back buttons)
const modeBtns = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

// The latest detector reading, held here because three consumers need it: the
// session (wait-mode and auto-advance), the Play render loop, and StrumCam.
let chord: ChordReading | null = null;
let lastChordAt = 0;

modeBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const m = btn.dataset.mode as AppMode | undefined;
    if (m !== "tuner" && m !== "play" && m !== "arrangement" && m !== "cal-mic" && m !== "library" && m !== "strumcam") return;
    if (m === currentMode()) return;
    const fromPractice = isPracticeMode(currentMode());
    const toPractice = isPracticeMode(m);
    // Chart and Play are both practice surfaces, so transport/backing/listening
    // state can continue while moving between them.
    if (!(fromPractice && toPractice)) {
      await nativeInvoke("stop_audio").catch(() => {});
      stopTunerListening();
      stopChordListening();
      setConn(false);
      syncKeepAwake();
    }
    if (fromPractice && !toPractice) {
      stopTransport();
      nativeInvoke("stop_backing").catch(() => {});
    }

    if (currentMode() === "strumcam" && m !== "strumcam") stopStrumcamSession();

    setMode(m);
    tunerView.hidden = m !== "tuner";
    playView.hidden = m !== "play";
    arrangementView.hidden = m !== "arrangement";
    setupView.hidden = m !== "cal-mic";
    libraryView.hidden = m !== "library";
    strumcamView.hidden = m !== "strumcam";
    // highlight the active utility button (Play has no util button → none lit)
    modeBtns.forEach((b) => b.classList.toggle("active", !!b.dataset.mode && b.dataset.mode === m));
    if (m === "library") renderSongList();
    if (m === "arrangement") updateArrangementState(true);
    cornerLabel.textContent =
      m === "tuner" ? "ukejam / Tuner · native"
      : m === "arrangement" ? "ukejam / Arrangement · native"
      : m === "cal-mic" ? "ukejam / Setup · native"
      : m === "library" ? "ukejam / Library · native"
      : m === "strumcam" ? "ukejam / StrumCam · native"
      : "ukejam / Chords · native";
  });
});

function loadSongIntoPlay(rec: SongRecord) {
  const song = getSong(rec.id);
  if (!song || !song.chordSequence.length) {
    setLibraryStatus("that song has no detectable chords");
    return;
  }
  // Drop the outgoing song's score BEFORE swapping loadedSong: setupTiming()
  // below calls stopTransport(), which would otherwise coach the old song's bars
  // against the new song's tempo and chord names.
  resetScoring();
  // Advice about the previous song is worse than none. Not folded into
  // resetScoring(), which also runs on a loop — where the advice the player just
  // read is still about the part they're replaying.
  resetCoaching();
  setLoadedSong(song, rec);
  buildSectionMap(song); // before setupTiming: a sealed bar reads this
  setupTiming(song);
  setupBacking(rec);
  buildSongStrip();
  buildLyrics();
  buildArrangement();
  setTarget(song.chordSequence[0]);
  updatePracticeUi();
  // jump to Play
  (document.querySelector('[data-mode="play"]') as HTMLButtonElement)?.click();
}

initSession({
  currentReading: () => chord,
  onPlayingChanged: (on) => {
    setPlayButtons(on);
    updatePracticeUi();
  },
  onTimeChanged: setTimeReadout,
  onTimingReady: setTimingReadout,
  onChordIndexChanged: () => {
    updateStrip();
    updateLyrics();
    updateArrangementState();
    updatePracticeUi();
  },
  onBackingChanged: setBackingControlsVisible,
  onBarSealed,
  requestCoaching,
  onScoringReset: resetCoachBarCount,
  onPracticeStateChanged: updatePracticeUi,
  syncKeepAwake,
});




// Canvas chord highway: tokens slide down toward a gold NOW line. When the song
// is timed, position comes from the wall-clock playhead (Rocksmith-style);
// otherwise it's a static lane of upcoming chords fanning up from the target.

// Build the lyric DOM: one row per non-empty SongLine, with chord cues
// positioned above the syllable they fall on (using chordPos). A flat map
// from global chord index -> token element drives the gold highlight.


onNative<ChordReading>("chord", (reading) => {
  chord = reading;
  lastChordAt = performance.now();
  setConn(true);
  noteTunerRms(reading.rms);
  // Every window's flux, onset or not: a stroke is asked afterwards how loud the
  // strings were around it, which is how the silent-sweep vs quiet-strum boundary
  // gets measured rather than guessed. No-op while the camera is off.
  noteCameraFlux(lastChordAt, reading.flux);
  // Fold this window into the bar being scored. Gated on the transport being
  // engaged so noodling with the song paused isn't graded — but NOT on `waiting`:
  // wait-for-me parks the playhead mid-bar precisely so the player can find the
  // chord, and that strum is the one the bar should be scored on. (Its timing
  // offset is meaningless in wait mode, which is the point of the mode.)
  // The mic now also runs under the StrumCam view; only the practice surfaces
  // grade bars or advance the song, so noodling in the lab can't touch a score.
  const practicing = isPracticeMode(currentMode());
  if (practicing && currentSong() && (!isTimed() || isPlaying())) {
    // Grade the strum at the moment it HAPPENED, not when its reading arrived:
    // the pipeline (capture buffer + emit coalescing + IPC) delivered it
    // 40-90ms late, the same order as the 70ms timing tolerance, so a player
    // dead on the beat read as "late". The camera fusion below deliberately
    // stays on arrival time — its pairing thresholds were tuned against it.
    accumulateReading(reading, lastChordAt - (reading.onsetAgeMs || 0));
  }
  if (reading.onset) {
    noteOnset(lastChordAt);
    // The camera needs every onset regardless of which screen is up: an onset is how
    // a stroke is judged sounded-or-ghost, and the Play screen scores ghosts too.
    // The lab view's own strip chart stays gated inside strumcamOnset.
    noteCameraOnset(lastChordAt);
    strumcamOnset(lastChordAt);
  }
  if (practicing) maybeAdvance(reading);
});

// Backing-track playback position from Rust anchors the highway playhead.
// Paused statuses matter too: they stop the dead-reckoning in tickTransport,
// so the playhead can't glide on while the engine is silent (wait-mode).
onNative<BackingStatus>("backing", (status) => {
  syncBackingPos(status.pos, status.latency ?? 0, status.playing);
});

initIosAudio({
  isChordListening,
  stopChordListening,
  startChordListening,
  setCoachMessage: (text) => setCoachMessage(text),
  markDisconnected: () => setConn(false),
  syncKeepAwake,
  onPracticeStateChanged: updatePracticeUi,
});

initSoundfont({
  // A song loaded before a SoundFont existed still has its MIDI staged; hand it
  // to the engine now that one is installed.
  onInstalled: () => {
    if (hasBackingAudio()) loadBackingIntoEngine();
  },
});

// Phone chrome (GarageBand-style: bottom tab bar, slim topbar, big transport).
// Keyed on the short viewport edge rather than the platform: a rotated iPhone
// must keep its tab bar even at 900px wide, an iPad must not get one, and a
// desktop window dragged phone-narrow is honestly phone-shaped. One class so
// every phone rule in the stylesheet agrees on what "phone" means.
function syncPhoneChrome() {
  document.body.classList.toggle("phone", Math.min(window.innerWidth, window.innerHeight) <= 520);
}
syncPhoneChrome();
window.addEventListener("resize", syncPhoneChrome);

// Mobile platforms have no user-facing file manager to open into the app's
// sandbox; hide desktop-only affordances and give CSS a hook (body.mobile)
// for touch-sized layout tweaks beyond what width queries catch.
void nativeInvoke<string>("platform")
  .then((os) => {
    if (os === "ios" || os === "android") {
      document.body.classList.add("mobile");
      hideSoundfontOpenFolder();
    }
  })
  .catch(() => {});


initTuningSetup({
  onTuningChanged: () => {
    rebuildStringRows();
    // Voicings and the chosen shape index are per-tuning; a G shape on a
    // baritone is a different list, so a stale index would point at nothing.
    resetVoicingsForTuningChange();
    invalidateFretboards();
    if (currentSong()) buildArrangement();
    updateArrangementState(true);
  },
  markDisconnected: () => setConn(false),
});


// Setup-screen panels. OpenRouter binds first: the AI panel's first render
// asks it for the Connect/Disconnect button state.
initOpenRouterAuth({
  aiConfig,
  setAiStatus,
  renderAiPanel,
  openSetupView: () => {
    (document.querySelector('.util-btn[data-mode="cal-mic"]') as HTMLButtonElement | null)?.click();
  },
});
initAiSettings();
resumeOpenRouterLogin();





function cycleChordShape(name: string, delta: number) {
  if (!cycleShapeChoice(name, activeTuning(), delta)) return;
  invalidateFretboards();
  redrawArrangementChordCards();
  updateTransitionCoach(true);
}





initStrumCam({
  isActiveView: () => currentMode() === "strumcam",
  setMicActive: (on) => {
    setChordListening(on);
    syncKeepAwake();
  },
});
