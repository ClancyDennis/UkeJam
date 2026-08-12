import {
  nativeInvoke,
  nativeListen,
  type BackingStatus,
  type ChordReading,
} from "./native";
import { getSong, type SongRecord } from "./library";
import { activeTuning } from "./tunings";
import {
  hideSoundfontOpenFolder,
  initSoundfont,
} from "./views/setup/soundfont";
import { aiConfig, initAiSettings, renderAiPanel, setAiStatus } from "./views/setup/aiSettings";
import { initOpenRouterAuth, resumeOpenRouterLogin } from "./views/setup/openrouterAuth";
import { initIosAudio } from "./iosAudio";
import { drawGauge, initGauge, setGaugeReadout } from "./views/play/gauge";
import { buildSongStrip, initStrip, updateStrip } from "./views/play/strip";
import { buildLyrics, initLyrics, updateLyrics } from "./views/play/lyrics";
import { drawHighway, initHighway } from "./views/play/highway";
import { drawChroma, initChroma } from "./views/play/chroma";
import { initBreakdown, renderBreakdown } from "./views/play/breakdown";
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
  paintFretboards,
  updateFretboardPanelState,
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
  decaySpectrum,
  drawFFT,
  easeSpectrum,
  initFft,
  setFftGoldPitchClasses,
} from "./views/play/fft";
import {
  accumulateReading,
  buildSectionMap,
  currentChordIdx,
  currentRecord,
  currentSong,
  currentTarget,
  hasBackingAudio,
  initSession,
  isCleanHit,
  isPlaying,
  isTargetGradeable,
  isTimed,
  isWaiting,
  jumpToChord,
  loadBackingIntoEngine,
  maybeAdvance,
  nextDistinctChord,
  resetScoring,
  setLoadedSong,
  setTarget,
  setupBacking,
  setupTiming,
  startTransport,
  stopTransport,
  syncBackingPos,
  tickTransport,
  verdictBuffer,
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
import { chordPitchClasses } from "./theory/chords";
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
  const want = isTunerListening() || chordListening || isPlaying();
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
initFretboard({ cycleChordShape, isChordListening: () => chordListening });
initArrangement({ cycleChordShape });
initLibraryView({ loadSongIntoPlay });
initTransport({ onPracticeStateChanged: updatePracticeUi });
initChroma();
initBreakdown();


// =====================================================================
// Play mode — live chord detection
// =====================================================================
const tunerView = document.getElementById("tuner-view")!;
const playView = document.getElementById("play-view")!;
const arrangementView = document.getElementById("arrangement-view")!;
const setupView = document.getElementById("setup-view")!;
const libraryView = document.getElementById("library-view")!;
const strumcamView = document.getElementById("strumcam-view")!;
const cornerLabel = document.getElementById("corner-label")!;
// any element with data-mode navigates (util buttons + back buttons)
const modeBtns = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

const chordNameEl = document.getElementById("chord-name")!;
const chordSubEl = document.getElementById("chord-sub")!;
const cleanTargetEl = document.getElementById("clean-target")!;
const coachEl = document.getElementById("coach")!;
const listenBtn2 = document.getElementById("listen-btn-2") as HTMLButtonElement;
// analyzer panel (right column)
const mMatchEl = document.getElementById("m-match")!;
const mfMatchEl = document.getElementById("mf-match") as HTMLElement;
const mFluxEl = document.getElementById("m-flux")!;
const mOnsetEl = document.getElementById("m-onset")!;



let chordListening = false;
let chord: ChordReading | null = null;
let lastChordAt = 0;
// When the last attack was seen, so the diagnostics lamp can stay lit long
// enough to perceive — an onset is true for one reading only.
let lastOnsetAt = 0;
let smoothClean = 0;

// build chromagram bars (vertical bars; `.fill` height is driven from chroma values)
// view navigation (Play is home; Tune + Setup are utility screens)
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
      chordListening = false;
      listenBtn2.textContent = "Start listening";
      listenBtn2.classList.remove("on");
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

listenBtn2.addEventListener("click", async () => {
  if (!chordListening) {
    try {
      await nativeInvoke("start_chords");
      await nativeInvoke("set_target", { chord: currentTarget() || null });
      chordListening = true;
      listenBtn2.textContent = "Stop listening";
      listenBtn2.classList.add("on");
      setConn(false);
      syncKeepAwake();
    } catch (e) {
      coachEl.textContent = `mic error: ${e}`;
    }
  } else {
    await nativeInvoke("stop_audio");
    chordListening = false;
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
    setConn(false);
    syncKeepAwake();
  }
  updatePracticeUi(); // mic live/idle text is no longer refreshed every frame
});

// Diagnostics drawer: the analyzer instrumentation (gauge, chroma, FFT, peaks)
// is hidden by default and slides up on demand. The canvases keep their layout
// size while hidden (see .drawer[hidden] in CSS) so the draw loop is harmless.
const diagBtn = document.getElementById("diag-btn")!;
const diagDrawer = document.getElementById("diag-drawer")!;
const diagCloseBtn = document.getElementById("diag-close")!;
function toggleDiagnostics(force?: boolean) {
  const open = force ?? diagDrawer.hidden;
  diagDrawer.hidden = !open;
  diagBtn.classList.toggle("on", open);
}
diagBtn.addEventListener("click", () => toggleDiagnostics());
diagCloseBtn.addEventListener("click", () => toggleDiagnostics(false));

// Hands-free practice controls (the instrument is in your hands): space toggles
// play/pause, ←/→ step the current chord, d toggles the diagnostics drawer.
// Only active on the Play screen and never when typing in a field.
addEventListener("keydown", (e) => {
  if (currentMode() !== "play") return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (isTimed()) (isPlaying() ? stopTransport() : startTransport());
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    jumpToChord(currentChordIdx() + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    jumpToChord(currentChordIdx() - 1);
  } else if (e.key === "d" || e.key === "D") {
    toggleDiagnostics();
  }
});


// --- practice header (shared by Play and Arrangement) ---
const songTagEl = document.getElementById("song-tag")!;
const modeTagEl = document.getElementById("mode-tag")!;
const practiceTitleEl = document.getElementById("practice-title")!;
const practiceSubEl = document.getElementById("practice-sub")!;
const practicePosEl = document.getElementById("practice-pos")!;
const practiceNextEl = document.getElementById("practice-next")!;

function updatePracticeUi() {
  const song = currentSong();
  // mode bar edge + tag: teal "free play" vs. gold "practice"
  playView.classList.toggle("free", !song);
  if (!song) {
    modeTagEl.textContent = "● Free play";
    songTagEl.textContent = "free detection";
    practiceTitleEl.textContent = "Free play";
    practiceSubEl.textContent = chordListening ? "mic live" : "mic idle";
    practicePosEl.textContent = "--";
    practiceNextEl.textContent = "choose song";
    return;
  }
  modeTagEl.textContent = "● Practice";

  const title = currentRecord()?.title || song.title || "Untitled";
  const artist = currentRecord()?.artist || song.artist;
  const current = song.chordSequence[currentChordIdx()] ?? "--";
  const next = nextDistinctChord();
  const modeText = isTimed()
    ? `${Math.round(song.tempo)} bpm · ${isWaiting() ? "waiting" : isPlaying() ? "playing" : "paused"}`
    : "play-to-advance";
  const micText = chordListening ? "mic live" : "mic idle";
  const backingText = hasBackingAudio() ? "backing" : "no backing";
  // Rolling score over the last 16 bars: enough history to mean something,
  // short enough that fixing a rough patch shows up while you're still on it.
  const score = verdictBuffer().hitCount(16);
  const scoreText = score.total ? ` · ${score.hits}/${score.total} bars` : "";
  // Rhythm alongside the chord score, because they fail independently: a player
  // can hold every chord perfectly and still strum once where the bar wants four.
  const rhythmText = isTimed() ? verdictBuffer().rhythmSummary(16) : "";

  songTagEl.textContent = artist ? `${title} · ${artist}` : title;
  practiceTitleEl.textContent = artist ? `${title} — ${artist}` : title;
  practiceSubEl.textContent =
    (isTimed() ? `${modeText} · ${micText} · ${backingText}` : `${modeText} · ${micText}`) +
    scoreText + rhythmText;
  practicePosEl.textContent = `${currentChordIdx() + 1}/${song.chordSequence.length} · ${current}`;
  practiceNextEl.textContent = next ? `next ${next}` : "last chord";
}





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


nativeListen<ChordReading>("chord", (event) => {
  chord = event.payload;
  lastChordAt = performance.now();
  setConn(true);
  noteTunerRms(event.payload.rms);
  // Fold this window into the bar being scored. Gated on the transport being
  // engaged so noodling with the song paused isn't graded — but NOT on `waiting`:
  // wait-for-me parks the playhead mid-bar precisely so the player can find the
  // chord, and that strum is the one the bar should be scored on. (Its timing
  // offset is meaningless in wait mode, which is the point of the mode.)
  // The mic now also runs under the StrumCam view; only the practice surfaces
  // grade bars or advance the song, so noodling in the lab can't touch a score.
  const practicing = isPracticeMode(currentMode());
  if (practicing && currentSong() && (!isTimed() || isPlaying())) {
    accumulateReading(event.payload, lastChordAt);
  }
  if (event.payload.onset) {
    lastOnsetAt = lastChordAt;
    strumcamOnset(lastChordAt);
  }
  if (practicing) maybeAdvance(event.payload);
});

// backing-track playback position from Rust drives the highway playhead
nativeListen<BackingStatus>("backing", (event) => {
  if (event.payload.playing) syncBackingPos(event.payload.pos);
});

initIosAudio({
  isChordListening: () => chordListening,
  stopChordListening: () => {
    chordListening = false;
    listenBtn2.textContent = "Start listening";
    listenBtn2.classList.remove("on");
  },
  startChordListening: async () => {
    await nativeInvoke("start_chords");
    await nativeInvoke("set_target", { chord: currentTarget() || null });
    chordListening = true;
    listenBtn2.textContent = "Stop listening";
    listenBtn2.classList.add("on");
  },
  setCoachMessage: (text) => {
    coachEl.textContent = text;
  },
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



// map a note name like "G" / "F#" / "Bb" / "G3" to a pitch-class index 0..11

function renderChords() {
  // This loop only paints the Play view. On other views, skip all the canvas /
  // DOM work but keep the transport tick alive on the Arrangement view so a
  // timed song without backing audio (wall-clock playhead) still advances.
  if (!isPracticeMode(currentMode())) {
    requestAnimationFrame(renderChords);
    return;
  }
  if (currentMode() === "arrangement") {
    tickTransport();
    requestAnimationFrame(renderChords);
    return;
  }
  const now = performance.now();
  // Drop a reading the mic has stopped refreshing. NOT gated on chordListening:
  // when the stream stops, the last reading used to sit on screen indefinitely,
  // so the hero chord kept asserting a verdict about audio from minutes ago —
  // visible as a lit-up "Locked in" on a freshly loaded song with the mic idle.
  if (chord && now - lastChordAt > 300) {
    chord = null;
    if (chordListening && now - lastChordAt > 1500) setConn(false);
  }

  const c = chord;
  let fretboardMatched = false;
  const targetPcs = chordPitchClasses(currentTarget());
  // FFT gold highlight follows the target chord if set, else the detected one
  setFftGoldPitchClasses(
    currentTarget()
      ? targetPcs
      : c && c.active && c.detected
        ? chordPitchClasses(c.detected)
        : []
  );
  if (c && c.active) {
    const pct = Math.round(c.cleanliness * 100);
    const clean = c.cleanliness >= 0.85;
    // hero chord = what to play (target) when a song is loaded; the detected
    // chord otherwise. For target chords, use the same tolerant note-diff hit
    // rule as the coach and auto-advance so the screen gives one verdict.
    const matched = currentTarget() ? isCleanHit(c) : !!c.detected;
    fretboardMatched = matched;
    const hero = currentTarget() || c.detected || "—";
    chordNameEl.textContent = hero;
    chordNameEl.className = "chord-name " + (matched ? "clean" : "dirty");
    // A target we can't parse gets no verdict at all — say so plainly instead of
    // reporting on a comparison that never happened.
    chordSubEl.textContent = !currentTarget()
      ? "Playing"
      : !isTargetGradeable()
        ? `can't grade ${currentTarget()} — heard ${c.detected || "—"}`
        : matched
          ? "Locked in"
          : `heard ${c.detected || "—"}`;
    smoothClean += (c.cleanliness - smoothClean) * 0.2;
    setGaugeReadout(`${pct}<span class="pct">%</span>`, clean ? "clean" : pct >= 70 ? "almost" : "off");
    cleanTargetEl.textContent = currentTarget() ? `target · ${currentTarget()}` : "free play";

    // coach text from missing/extra
    if (!currentTarget()) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">free play</span> · heard <b>${c.detected || "—"}</b>`;
    } else if (!isTargetGradeable()) {
      coachEl.className = "coach";
      coachEl.innerHTML = `<span class="miss">can't grade <b>${currentTarget()}</b></span> — not a chord we know, so this bar isn't scored`;
    } else if (isCleanHit(c)) {
      coachEl.className = "coach good";
      coachEl.innerHTML = `<span class="ok">nice — that's a clean ${currentTarget()} ✓</span>`;
    } else {
      coachEl.className = "coach";
      const parts: string[] = [];
      if (c.missing.length)
        parts.push(`<span class="miss">missing <b>${c.missing.join(", ")}</b></span> — check that string is ringing`);
      if (c.extra.length)
        parts.push(`<span class="miss">extra <b>${c.extra.join(", ")}</b></span> — try muting`);
      coachEl.innerHTML = parts.join("<br>");
    }
    renderBreakdown(c);

    // chromagram (height-driven vertical bars)
    drawChroma(c.chroma, targetPcs);

    // spectrum: ease smoothed buffer toward incoming 96 real bins
    easeSpectrum(c.spectrum ?? []);

    // analyzer: match% follows cleanliness vs the target (or detection conf)
    mMatchEl.textContent = `${pct}%`;
    mfMatchEl.style.width = `${pct}%`;
    mfMatchEl.classList.toggle("gold", !matched);
    // onset detector: flux ratio plus a lamp held on for 140ms, since `onset` is
    // true for a single reading and would otherwise be invisible.
    mFluxEl.textContent = `${c.flux.toFixed(1)}x`;
    mOnsetEl.classList.toggle("lit", now - lastOnsetAt < 140);

    paintFretboards(c.detected, matched);
  } else {
    chordNameEl.textContent = currentTarget() || "—";
    chordNameEl.className = "chord-name";
    chordSubEl.textContent = currentTarget() ? "Play this" : "Playing";
    smoothClean += (0 - smoothClean) * 0.15;
    setGaugeReadout(`0<span class="pct">%</span>`, chordListening ? "listening…" : "idle");
    cleanTargetEl.textContent = currentTarget() ? `target · ${currentTarget()}` : "free play";
    coachEl.className = "coach good";
    coachEl.textContent = chordListening ? "play a chord" : "press start to listen";
    renderBreakdown(null);
    mMatchEl.textContent = "—";
    mfMatchEl.style.width = "0%";
    mFluxEl.textContent = "—";
    mOnsetEl.classList.remove("lit");
    drawChroma(null, targetPcs);
    // flat FFT when idle
    decaySpectrum();
    paintFretboards("", false);
  }

  tickTransport();
  updateFretboardPanelState(fretboardMatched);
  drawHighway();
  drawGauge(smoothClean, c?.active ?? false);
  drawFFT();
  requestAnimationFrame(renderChords);
}


function cycleChordShape(name: string, delta: number) {
  if (!cycleShapeChoice(name, activeTuning(), delta)) return;
  invalidateFretboards();
  redrawArrangementChordCards();
  updateTransitionCoach(true);
}




requestAnimationFrame(renderChords);

initStrumCam({
  isActiveView: () => currentMode() === "strumcam",
  setMicActive: (on) => {
    chordListening = on;
    syncKeepAwake();
  },
});
