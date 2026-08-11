import {
  nativeInvoke,
  nativeListen,
  type BackingStatus,
  type ChordReading,
} from "./native";
import { addSong, listSongs, deleteSong, getSong, renameSong, libraryReady, LibraryFullError, type SongRecord } from "./library";
import type { SongLine } from "./song";
import { invokeAiConfig } from "./ai";
import { parseChordChart, buildFusedChordPro } from "./midi";
import {
  timingLabel,
  type BarVerdict,
} from "./verdict";
import { activeTuning } from "./tunings";
import { fmtTime } from "./time";
import {
  hideSoundfontOpenFolder,
  initSoundfont,
} from "./views/setup/soundfont";
import {
  aiConfig,
  aiConfigReady,
  aiEnhanceProblem,
  initAiSettings,
  renderAiPanel,
  setAiStatus,
} from "./views/setup/aiSettings";
import { initOpenRouterAuth, resumeOpenRouterLogin } from "./views/setup/openrouterAuth";
import { initTabSearch } from "./views/tabSearch";
import { clearMidiStaging, initMidiImport, stagedMidi } from "./views/midiImport";
import { escapeHtml } from "./dom";
import { initIosAudio } from "./iosAudio";
import { drawGauge, initGauge, setGaugeReadout } from "./views/play/gauge";
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
  backingTrackList,
  barBeats,
  beatOfChord,
  buildSectionMap,
  currentChordIdx,
  currentRecord,
  currentSong,
  currentSongTime,
  currentTarget,
  hasBackingAudio,
  initSession,
  isCleanHit,
  isPlaying,
  isTargetGradeable,
  isTimed,
  isWaiting,
  jumpToChord,
  LOOKAHEAD_BEATS,
  loadBackingIntoEngine,
  maybeAdvance,
  nextDistinctChord,
  nextDistinctChordInfo,
  resetScoring,
  restartTransport,
  secondsPerBeat,
  selectedBackingChannels,
  setBackingChannels,
  setLoadedSong,
  setTarget,
  setupBacking,
  setupTiming,
  startTransport,
  stopTransport,
  syncBackingPos,
  tickTransport,
  toggleWaitMode,
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
import { PITCH_CLASSES, chordPitchClasses, pcNameToIndex } from "./theory/chords";
import {
  chordShapeState,
  cycleShapeChoice,
  resetVoicingsForTuningChange,
  shapeLabel,
  voicingKey,
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
const highway = document.getElementById("highway") as HTMLCanvasElement;
const hctx = highway.getContext("2d")!;
const transportEl = document.getElementById("transport")!;
const tpPlayBtn = document.getElementById("tp-play") as HTMLButtonElement;
const tpRestartBtn = document.getElementById("tp-restart") as HTMLButtonElement;
const tpTimeEl = document.getElementById("tp-time")!;
const tpBpmEl = document.getElementById("tp-bpm")!;
const backingControlsEl = document.getElementById("backing-controls")!;
const tpTracksBtn = document.getElementById("tp-tracks") as HTMLButtonElement;
const tpWaitBtn = document.getElementById("tp-wait") as HTMLButtonElement;
const trackPickerEl = document.getElementById("track-picker")!;
const arrTransportEl = document.getElementById("arr-transport")!;
const arrPlayBtn = document.getElementById("arr-play") as HTMLButtonElement;
const arrRestartBtn = document.getElementById("arr-restart") as HTMLButtonElement;
const arrTimeEl = document.getElementById("arr-time")!;
const arrBpmEl = document.getElementById("arr-bpm")!;
const cleanTargetEl = document.getElementById("clean-target")!;
const coachEl = document.getElementById("coach")!;
const targetNotesEl = document.getElementById("target-notes")!;
const listenBtn2 = document.getElementById("listen-btn-2") as HTMLButtonElement;
const chromaEl = document.getElementById("chroma")!;
const currentFretboardEl = document.getElementById("current-fretboard")!;
const currentFingerTagEl = document.getElementById("current-finger-tag")!;
const currentFingerTitleEl = document.getElementById("current-finger-title")!;
const currentFingerPanelEl = document.querySelector<HTMLElement>(".current-finger-panel")!;
const currentShapeControlsEl = document.getElementById("current-shape-controls")!;
const currentShapePrevBtn = document.getElementById("current-shape-prev") as HTMLButtonElement;
const currentShapeNextBtn = document.getElementById("current-shape-next") as HTMLButtonElement;
const currentShapeCountEl = document.getElementById("current-shape-count")!;
const fretboardEl = document.getElementById("fretboard")!;
const fingerTagEl = document.getElementById("finger-tag")!;
const fingerTitleEl = document.getElementById("finger-title")!;
const nextFingerPanelEl = document.querySelector<HTMLElement>(".next-finger-panel")!;
const nextShapeControlsEl = document.getElementById("next-shape-controls")!;
const nextShapePrevBtn = document.getElementById("next-shape-prev") as HTMLButtonElement;
const nextShapeNextBtn = document.getElementById("next-shape-next") as HTMLButtonElement;
const nextShapeCountEl = document.getElementById("next-shape-count")!;
const transitionTagEl = document.getElementById("transition-tag")!;
const transitionCoachEl = document.getElementById("transition-coach")!;
// analyzer panel (right column)
const mMatchEl = document.getElementById("m-match")!;
const mfMatchEl = document.getElementById("mf-match") as HTMLElement;
const mFluxEl = document.getElementById("m-flux")!;
const mOnsetEl = document.getElementById("m-onset")!;
const arrangementTagEl = document.getElementById("arrangement-tag")!;
const arrangementNowEl = document.getElementById("arr-now")!;
const arrangementNextEl = document.getElementById("arr-next")!;
const arrangementCountEl = document.getElementById("arr-count")!;
const arrangementEmptyEl = document.getElementById("arrangement-empty")!;
const arrangementSheetEl = document.getElementById("arrangement-sheet")!;
const arrangementChordsEl = document.getElementById("arrangement-chords")!;
const arrangementChordTagEl = document.getElementById("arrangement-chord-tag")!;



let chordListening = false;
let chord: ChordReading | null = null;
let lastChordAt = 0;
// When the last attack was seen, so the diagnostics lamp can stay lit long
// enough to perceive — an onset is true for one reading only.
let lastOnsetAt = 0;
let smoothClean = 0;

// build chromagram bars (vertical bars; `.fill` height is driven from chroma values)
const chromaFills: HTMLElement[] = [];
const chromaBars: HTMLElement[] = [];
for (let i = 0; i < 12; i++) {
  const bar = document.createElement("div");
  bar.className = "chroma-bar";
  bar.innerHTML = `<div class="track"><div class="fill"></div></div><span class="pc">${PITCH_CLASSES[i]}</span>`;
  chromaEl.appendChild(bar);
  chromaBars.push(bar);
  chromaFills.push(bar.querySelector(".fill")!);
}

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

// --- view state that follows the session's chord index ---
// Element lists the play and arrangement screens rebuild when a song loads, so
// currentChordIdx() -> {chip, lyric token, arrangement chord} stays O(1).
let stripChordEls: HTMLElement[] = [];
let lyricTokenEls: (HTMLElement | null)[] = [];
let lyricLineOfIdx: HTMLElement[] = [];
let arrangementChordEls: HTMLElement[] = [];
let arrangementLineOfIdx: HTMLElement[] = [];
let arrangementChordCards = new Map<string, HTMLElement>();
let lastArrangementScrollIdx = -1;

// How many bars the highway keeps tinted behind the NOW line.
const VERDICT_TRAIL_BARS = 3;

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

// =====================================================================
// Library + loaded song (chord strip in Play, auto-advance)
// =====================================================================
const pasteBox = document.getElementById("paste-box") as HTMLTextAreaElement;
const songTitleInput = document.getElementById("song-title") as HTMLInputElement;
const songArtistInput = document.getElementById("song-artist") as HTMLInputElement;
const addSongBtn = document.getElementById("add-song-btn") as HTMLButtonElement;
const lyricsBox = document.getElementById("lyrics-box") as HTMLTextAreaElement;
const aiEnhanceToggle = document.getElementById("ai-enhance") as HTMLInputElement;
const libAddStatus = document.getElementById("lib-add-status")!;
const songListEl = document.getElementById("song-list")!;
const libCountEl = document.getElementById("lib-count")!;
const songBarEmpty = document.getElementById("song-bar-empty")!;
const songStrip = document.getElementById("song-strip")!;
const lyricsView = document.getElementById("lyrics-view")!;
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

// Parse the LLM's "barNumber: words" reply into a map, ignoring anything that
// isn't a valid `N: text` line or points outside 1..barCount. The LLM only
// supplies words; we never trust it with structure.
function parseBarLyrics(reply: string, barCount: number): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of reply.split(/\r?\n/)) {
    const mm = line.match(/^\s*(\d+)\s*[:.\)]\s*(.+)$/);
    if (!mm) continue;
    const n = parseInt(mm[1], 10);
    const words = mm[2].trim();
    if (n >= 1 && n <= barCount && words) m.set(n, words);
  }
  return m;
}

addSongBtn.addEventListener("click", async () => {
  const text = pasteBox.value.trim();
  if (!text) {
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "paste a tab first";
    return;
  }

  let source = text;
  const lyricTab = lyricsBox.value.trim();
  // mode: fuse a lyric tab onto a MIDI chart, simplify a MIDI chart, or convert
  // a messy pasted tab. (fuse needs both a staged MIDI and pasted lyrics.)
  const staged = stagedMidi();
  const mode = staged && lyricTab ? "fuse" : staged ? "midi" : "messy";
  // The saved provider config is read from the native store asynchronously at
  // boot; a song added before that lands would otherwise be enhanced with the
  // seeded default rather than what the player configured.
  if (aiEnhanceToggle.checked) await aiConfigReady;
  // A provider that can't run (no key, Apple Intelligence unavailable) skips
  // the AI step with a pointer to Setup instead of failing a doomed request.
  const aiProblem = aiEnhanceToggle.checked ? aiEnhanceProblem() : null;
  // When the AI step is skipped, its explanation must survive the generic
  // "added …" status written after the save.
  let aiSkipNote = false;
  if (mode === "fuse" && aiEnhanceToggle.checked && !aiProblem) {
    // Lyric fusion: the app OWNS the bar/chord structure. We send the LLM a
    // numbered bar list + the lyrics and ask only for "barN: words" lines, then
    // rebuild the ChordPro deterministically — so the bar count and chords can
    // never drift and the lyrics stay locked to the recording's timing.
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ laying lyrics over the timing…";
    try {
      const { header, bars } = parseChordChart(text);
      const numbered = bars.map((c, i) => `${i + 1}. ${c}`).join("\n");
      const reply = await nativeInvoke<string>("enhance_tab", {
        raw: numbered,
        mode: "fuse",
        lyrics: lyricTab,
        config: invokeAiConfig(aiConfig),
      });
      const lyricByBar = parseBarLyrics(reply, bars.length);
      source = buildFusedChordPro(header, bars, lyricByBar);
      libAddStatus.textContent = `laid ${lyricByBar.size} bars of lyrics over ${bars.length} bars`;
    } catch (e) {
      libAddStatus.textContent = `lyric fusion failed (${e}) — saved chart only`;
    } finally {
      addSongBtn.disabled = false;
    }
  } else if (mode === "fuse") {
    // can't fuse without the LLM; keep the timed chart, note the skip
    aiSkipNote = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = aiProblem
      ? `${aiProblem} — open ⚙ Setup · saved chart only`
      : "lyrics need ✨ AI enhance to merge — saved chart only";
  } else if (aiEnhanceToggle.checked && aiProblem) {
    aiSkipNote = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = `${aiProblem} — open ⚙ Setup · saved raw`;
  } else if (aiEnhanceToggle.checked) {
    addSongBtn.disabled = true;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "✨ enhancing with AI…";
    try {
      const cleaned = await nativeInvoke<string>("enhance_tab", {
        raw: text,
        mode,
        lyrics: null,
        config: invokeAiConfig(aiConfig),
      });
      if (cleaned && cleaned.trim()) source = cleaned.trim();
    } catch (e) {
      libAddStatus.textContent = `AI enhance failed (${e}) — saved raw`;
    } finally {
      addSongBtn.disabled = false;
    }
  }

  let rec: SongRecord;
  try {
    rec = addSong(source, {
      title: songTitleInput.value,
      artist: songArtistInput.value,
      midi: stagedMidi()?.b64,
      tracks: stagedMidi()?.tracks,
    });
  } catch (e) {
    // most likely the localStorage quota (large MIDI imports) — surface it
    // instead of silently dropping the song.
    libAddStatus.classList.remove("done");
    libAddStatus.textContent =
      e instanceof LibraryFullError
        ? `couldn't save — ${e.message}. Delete a song and try again.`
        : `couldn't save: ${e}`;
    return;
  }
  if (!aiSkipNote && !libAddStatus.textContent?.includes("failed")) {
    libAddStatus.classList.add("done");
    const withMidi = stagedMidi() ? " · backing track ♪" : "";
    libAddStatus.textContent = `added "${rec.title}"${rec.artist ? " — " + rec.artist : ""}${withMidi}`;
  }
  pasteBox.value = "";
  songTitleInput.value = "";
  songArtistInput.value = "";
  lyricsBox.value = "";
  clearMidiStaging();
  renderSongList();
  loadSongIntoPlay(rec);
});

initTabSearch({
  onTabLoaded: (tab) => {
    clearMidiStaging(); // fetched text replaces any staged MIDI chart
    pasteBox.value = tab.text;
    songTitleInput.value = tab.title;
    songArtistInput.value = tab.artist;
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "";
  },
});


initMidiImport({
  pasteBox,
  titleInput: songTitleInput,
  artistInput: songArtistInput,
  lyricsBox,
  setStatus: (text, done = false) => {
    libAddStatus.classList.toggle("done", done);
    libAddStatus.textContent = text;
  },
});


function renderSongList() {
  const songs = listSongs();
  libCountEl.textContent = String(songs.length);
  songListEl.innerHTML = "";
  if (!songs.length) {
    songListEl.innerHTML = `<div class="song-list-empty">No songs yet. Paste a tab on the left to add one.</div>`;
    return;
  }
  for (const s of songs) {
    const row = document.createElement("div");
    row.className = "song-row";
    row.innerHTML = `
      <span class="s-title">${escapeHtml(s.title)}</span>
      <span class="s-artist">${escapeHtml(s.artist)}</span>
      <span class="s-meta">load →</span>
      <button class="s-edit" title="Rename">✎</button>
      <button class="s-del" title="Delete">✕</button>`;
    row.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("s-del")) {
        deleteSong(s.id);
        renderSongList();
        return;
      }
      if (t.classList.contains("s-edit")) {
        const title = prompt("Song title:", s.title);
        if (title === null) return;
        const artist = prompt("Artist:", s.artist) ?? s.artist;
        renameSong(s.id, title, artist);
        renderSongList();
        return;
      }
      loadSongIntoPlay(s);
    });
    songListEl.appendChild(row);
  }
}

// The list renders from the in-memory library, which starts on the
// localStorage seed; refresh it once the durable native store has loaded.
void libraryReady.then(() => {
  if (currentMode() === "library") renderSongList();
});

function loadSongIntoPlay(rec: SongRecord) {
  const song = getSong(rec.id);
  if (!song || !song.chordSequence.length) {
    libAddStatus.classList.remove("done");
    libAddStatus.textContent = "that song has no detectable chords";
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
    tpPlayBtn.textContent = on ? "❚❚" : "▶";
    tpPlayBtn.classList.toggle("on", on);
    arrPlayBtn.textContent = on ? "❚❚" : "▶";
    arrPlayBtn.classList.toggle("on", on);
    updatePracticeUi();
  },
  onTimeChanged: (sec) => {
    tpTimeEl.textContent = fmtTime(sec);
    arrTimeEl.textContent = fmtTime(sec);
  },
  onTimingReady: (timed, tempo) => {
    transportEl.hidden = !timed;
    arrTransportEl.hidden = !timed;
    if (!timed) return;
    tpBpmEl.textContent = `${Math.round(tempo)} bpm`;
    arrBpmEl.textContent = `${Math.round(tempo)} bpm`;
  },
  onChordIndexChanged: updateStrip,
  onBackingChanged: (has) => {
    if (has) buildTrackPicker();
    backingControlsEl.hidden = !has;
  },
  onBarSealed,
  requestCoaching,
  onScoringReset: resetCoachBarCount,
  onPracticeStateChanged: updatePracticeUi,
  syncKeepAwake,
});

tpPlayBtn.addEventListener("click", () => (isPlaying() ? stopTransport() : startTransport()));
tpRestartBtn.addEventListener("click", restartTransport);
arrPlayBtn.addEventListener("click", () => (isPlaying() ? stopTransport() : startTransport()));
arrRestartBtn.addEventListener("click", restartTransport);

tpWaitBtn.addEventListener("click", () => {
  tpWaitBtn.classList.toggle("on", toggleWaitMode());
  updatePracticeUi();
});

tpTracksBtn.addEventListener("click", () => {
  trackPickerEl.hidden = !trackPickerEl.hidden;
});

// Build the channel checklist; toggling reloads the backing with the new mix.
function buildTrackPicker() {
  trackPickerEl.innerHTML = "";
  for (const t of backingTrackList()) {
    const on = selectedBackingChannels().includes(t.channel);
    const row = document.createElement("label");
    row.className = "track-opt";
    row.innerHTML =
      `<input type="checkbox" ${on ? "checked" : ""} /> ` +
      `<span>${escapeHtml(t.name)}</span>` +
      `<span class="t-meta">${t.isDrums ? "drums" : t.isBass ? "bass" : "ch" + (t.channel + 1)} · ${t.noteCount}</span>`;
    const cb = row.querySelector("input") as HTMLInputElement;
    cb.addEventListener("change", () => {
      const channels = selectedBackingChannels();
      // re-filter in place: keeps the current position + play state (no reload,
      // no resend of the file), so the song doesn't restart on a toggle.
      setBackingChannels(
        cb.checked
          ? channels.includes(t.channel) ? channels : [...channels, t.channel]
          : channels.filter((c) => c !== t.channel)
      );
    });
    trackPickerEl.appendChild(row);
  }
}

function buildSongStrip() {
  const song = currentSong();
  songStrip.innerHTML = "";
  stripChordEls = [];
  if (!song) return;
  songBarEmpty.hidden = true;
  songStrip.hidden = false;
  const hasBars = song.barStart.some(Boolean);
  song.chordSequence.forEach((ch, i) => {
    // bar separator before any chord (except the first) that starts a measure
    if (hasBars && i > 0 && song!.barStart[i]) {
      const sep = document.createElement("span");
      sep.className = "bar-sep";
      songStrip.appendChild(sep);
    }
    const el = document.createElement("span");
    el.className = "strip-chord";
    el.textContent = ch;
    el.addEventListener("click", () => {
      jumpToChord(stripChordEls.indexOf(el));
    });
    songStrip.appendChild(el);
    stripChordEls.push(el);
  });
  updateStrip();
}

function updateStrip() {
  stripChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < currentChordIdx());
    el.classList.toggle("current", i === currentChordIdx());
    // Verdict tint persists for the whole run, so the strip doubles as a map of
    // where the song went wrong — the highway trail only shows the last few bars.
    const v = verdictBuffer().forChordIdx(i);
    el.classList.toggle("hit", v?.status === "HIT");
    el.classList.toggle("wrong", v?.status === "WRONG");
    el.classList.toggle("miss", v?.status === "MISS");
  });
  // keep the current chord in view
  stripChordEls[currentChordIdx()]?.scrollIntoView({ block: "nearest", inline: "center" });
  updateLyrics();
  updateArrangementState();
  updatePracticeUi();
}

type ArrangementChord = {
  name: string;
  idx: number;
  firstInBar: boolean;
};

function arrangementBarsForLine(line: SongLine, startIdx: number): ArrangementChord[][] {
  const bars: ArrangementChord[][] = [];
  const hasBarMarkers = line.barStart.some(Boolean);
  line.chords.forEach((name, i) => {
    const startsBar = i === 0 || line.barStart[i] || (!hasBarMarkers && i > 0 && i % 4 === 0);
    if (startsBar || !bars.length) bars.push([]);
    bars[bars.length - 1].push({ name, idx: startIdx + i, firstInBar: startsBar });
  });
  return bars;
}

function buildArrangement() {
  const song = currentSong();
  arrangementSheetEl.innerHTML = "";
  arrangementChordsEl.innerHTML = "";
  arrangementChordEls = [];
  arrangementLineOfIdx = [];
  arrangementChordCards = new Map();
  lastArrangementScrollIdx = -1;

  if (!song) {
    arrangementTagEl.textContent = "no song";
    arrangementChordTagEl.textContent = activeTuning().spelling;
    arrangementEmptyEl.hidden = false;
    arrangementSheetEl.hidden = true;
    updateArrangementState();
    return;
  }

  arrangementEmptyEl.hidden = true;
  arrangementSheetEl.hidden = false;
  const title = currentRecord()?.title || song.title || "Untitled";
  const artist = currentRecord()?.artist || song.artist;
  arrangementTagEl.textContent = artist ? `${title} · ${artist}` : title;
  arrangementChordTagEl.textContent = `${song.uniqueChords.length} shapes`;

  let globalIdx = 0;
  for (const line of song.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "arr-section";
      sec.textContent = line.section;
      arrangementSheetEl.appendChild(sec);
      continue;
    }

    const hasContent = line.chords.length || line.lyric.trim();
    if (!hasContent) continue;

    const row = document.createElement("div");
    row.className = "arr-line";
    if (!line.chords.length) row.classList.add("lyric-only");

    if (line.chords.length) {
      const chordRow = document.createElement("div");
      chordRow.className = "arr-chord-row";
      for (const bar of arrangementBarsForLine(line, globalIdx)) {
        const barEl = document.createElement("div");
        barEl.className = "arr-bar";
        for (const item of bar) {
          const chordEl = document.createElement("button");
          chordEl.className = "arr-chord";
          chordEl.type = "button";
          chordEl.textContent = item.name;
          chordEl.addEventListener("click", () => jumpToChord(item.idx));
          barEl.appendChild(chordEl);
          arrangementChordEls[item.idx] = chordEl;
          arrangementLineOfIdx[item.idx] = row;
        }
        chordRow.appendChild(barEl);
      }
      row.appendChild(chordRow);
    }

    const lyric = document.createElement("div");
    lyric.className = "arr-lyric";
    lyric.textContent = line.lyric.trim() || "instrumental";
    row.appendChild(lyric);
    arrangementSheetEl.appendChild(row);
    globalIdx += line.chords.length;
  }

  const counts = new Map<string, number>();
  song.chordSequence.forEach((ch) => counts.set(ch, (counts.get(ch) ?? 0) + 1));
  song.uniqueChords.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "arr-chord-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Jump to first ${ch}`);
    const state = chordShapeState(ch, activeTuning());
    card.innerHTML =
      `<span class="arr-card-head">` +
      `<span class="arr-card-name">${escapeHtml(ch)}</span>` +
      `<span class="arr-card-meta"><span class="arr-card-count">${counts.get(ch) ?? 0}x</span><span class="arr-card-shape">${state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1"}</span></span>` +
      `<span class="arr-card-actions">` +
      `<button class="arr-shape-btn arr-shape-prev" title="Previous fingering">&lsaquo;</button>` +
      `<button class="arr-shape-btn arr-shape-next" title="Next fingering">&rsaquo;</button>` +
      `</span>` +
      `</span>` +
      `<svg class="arr-mini-fret" viewBox="0 0 150 200" aria-label="${escapeHtml(ch)} fingering"></svg>`;
    const firstIdx = song!.chordSequence.indexOf(ch);
    card.addEventListener("click", () => jumpToChord(firstIdx));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      jumpToChord(firstIdx);
    });
    card.querySelector(".arr-shape-prev")?.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleChordShape(ch, -1);
    });
    card.querySelector(".arr-shape-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleChordShape(ch, 1);
    });
    arrangementChordsEl.appendChild(card);
    arrangementChordCards.set(ch, card);
    drawFretboard(
      ch,
      false,
      "Up Next",
      {
        svg: card.querySelector(".arr-mini-fret")!,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });

  redrawArrangementChordCards();
  updateArrangementState(true);
}

function updateArrangementState(forceScroll = false) {
  const song = currentSong();
  const next = nextDistinctChordInfo();
  if (!song) {
    arrangementNowEl.textContent = "--";
    arrangementNextEl.textContent = "--";
    arrangementCountEl.textContent = "--";
    return;
  }

  const current = song.chordSequence[currentChordIdx()] ?? "--";
  arrangementNowEl.textContent = current;
  arrangementNextEl.textContent = next.name || "end";
  arrangementCountEl.textContent = `${currentChordIdx() + 1}/${song.chordSequence.length}`;

  arrangementChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < currentChordIdx());
    el.classList.toggle("now", i === currentChordIdx());
    el.classList.toggle("next", next.index >= 0 && i === next.index);
  });

  const curLine = arrangementLineOfIdx[currentChordIdx()];
  arrangementSheetEl.querySelectorAll(".arr-line").forEach((line) => {
    line.classList.toggle("now", line === curLine);
  });

  arrangementChordCards.forEach((card, name) => {
    card.classList.toggle("now", name === current);
    card.classList.toggle("next", !!next.name && name === next.name);
  });

  if ((forceScroll || lastArrangementScrollIdx !== currentChordIdx()) && curLine && !arrangementView.hidden) {
    curLine.scrollIntoView({ block: "center" });
    lastArrangementScrollIdx = currentChordIdx();
  }
}

// Canvas chord highway: tokens slide down toward a gold NOW line. When the song
// is timed, position comes from the wall-clock playhead (Rocksmith-style);
// otherwise it's a static lane of upcoming chords fanning up from the target.
function drawHighway() {
  const song = currentSong();
  const dpr = window.devicePixelRatio || 1;
  const rect = highway.getBoundingClientRect();
  const w = rect.width || 360;
  const h = rect.height || 260;
  if (highway.width !== Math.round(w * dpr) || highway.height !== Math.round(h * dpr)) {
    highway.width = Math.round(w * dpr);
    highway.height = Math.round(h * dpr);
  }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const nowY = h - 64; // NOW line sits just above the big current chord
  const topY = 28;
  const TEAL = "25,227,196";
  const GOLD = "245,196,81";
  // Verdict colours for the trail behind NOW. Green/amber/grey reads at a glance
  // without needing the legend a fourth colour would. These mirror
  // --verdict-hit/-wrong/-miss in styles.css, which tint the same bars on the
  // song strip; canvas needs the components separately for rgba(), hence the
  // duplication.
  const HIT = "76,222,128"; // --verdict-hit  #4cde80
  const WRONG = "245,158,66"; // --verdict-wrong #f59e42
  const MISS = "120,132,146"; // --verdict-miss  #788492

  if (!song) return;
  const seq = song.chordSequence;

  // perspective rails converging toward NOW
  hctx.strokeStyle = `rgba(${TEAL},0.12)`;
  hctx.lineWidth = 1;
  [[-1, 0.42, -1, 0.12], [1, 0.42, 1, 0.12]].forEach(([s, tb, , tt]) => {
    hctx.beginPath();
    hctx.moveTo(cx + (s as number) * w * (tt as number), topY);
    hctx.lineTo(cx + (s as number) * w * (tb as number), nowY);
    hctx.stroke();
  });

  // playhead beat (timed) or a synthetic position from the chord index (untimed)
  const headBeat = isTimed() ? currentSongTime() / secondsPerBeat() : (beatOfChord(currentChordIdx()) ?? currentChordIdx());

  // How far behind NOW the graded trail extends, in beats.
  const trailBeats = isTimed() ? VERDICT_TRAIL_BARS * barBeats() : VERDICT_TRAIL_BARS;

  // draw upcoming tokens from nearest-future back, mapping beat-distance to y.
  // Bars the playhead has already crossed stay on screen for a few beats, tinted
  // by their verdict — the player sees how the last bars went without looking
  // away from where they're going.
  for (let i = 0; i < seq.length; i++) {
    const tb = isTimed() ? beatOfChord(i) : i;
    const rel = tb - headBeat; // beats ahead of the playhead (0 = at NOW)
    if (rel > LOOKAHEAD_BEATS) break; // too far ahead
    const passed = rel < -0.6;
    const verdict = passed ? verdictBuffer().forChordIdx(i) : undefined;
    if (passed && (!verdict || rel < -trailBeats)) continue; // off the trail
    if (passed) {
      drawTrailToken(hctx, cx, nowY, verdict!, -rel / trailBeats, seq[i], { HIT, WRONG, MISS });
      continue;
    }
    const prog = Math.max(0, Math.min(1, rel / LOOKAHEAD_BEATS)); // 0 near .. 1 far
    const y = nowY - prog * (nowY - topY);
    const scale = 1 - prog * 0.55;
    const alpha = 1 - prog * 0.78;
    const isNow = rel < (isTimed() ? 0.5 : 0.5) && i === currentChordIdx();
    const col = isNow ? GOLD : TEAL;
    const tw = 60 * scale;
    const th = 30 * scale;
    roundRect(hctx, cx - tw / 2, y - th / 2, tw, th, 8 * scale);
    hctx.globalAlpha = alpha;
    hctx.strokeStyle = `rgba(${col},${isNow ? 0.95 : 0.55})`;
    hctx.lineWidth = 1.5 * scale;
    hctx.shadowColor = `rgba(${col},0.7)`;
    hctx.shadowBlur = isNow ? 14 : 6 * scale;
    hctx.stroke();
    hctx.fillStyle = `rgba(${col},0.06)`;
    hctx.fill();
    hctx.shadowBlur = 0;
    hctx.fillStyle = `rgba(${col},${isNow ? 1 : 0.9})`;
    hctx.font = `700 ${Math.round(22 * scale)}px "Chakra Petch", sans-serif`;
    hctx.textAlign = "center";
    hctx.textBaseline = "middle";
    hctx.fillText(seq[i], cx, y + 1);
    hctx.globalAlpha = 1;
  }

  // gold NOW line
  hctx.shadowColor = `rgba(${GOLD},0.8)`;
  hctx.shadowBlur = 14;
  hctx.strokeStyle = `rgba(${GOLD},0.95)`;
  hctx.lineWidth = 2;
  hctx.beginPath();
  hctx.moveTo(w * 0.12, nowY);
  hctx.lineTo(w * 0.88, nowY);
  hctx.stroke();
  hctx.shadowBlur = 0;
}

// A bar the playhead has passed, drawn below the NOW line and tinted by its
// verdict. `fade` runs 0 (just passed) -> 1 (leaving the trail); the token
// shrinks and dims as it goes so it never competes with what's coming.
//
// The timing arrow is the point of the whole onset detector: ▲ = you strummed
// early, ▼ = late. Only drawn past TIMING_TOLERANCE_MS, since below that the
// number is mostly detector latency rather than the player.
function drawTrailToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  nowY: number,
  v: BarVerdict,
  fade: number,
  label: string,
  cols: { HIT: string; WRONG: string; MISS: string }
) {
  const f = Math.max(0, Math.min(1, fade));
  const col = v.status === "HIT" ? cols.HIT : v.status === "WRONG" ? cols.WRONG : cols.MISS;
  const y = nowY + 20 + f * 26;
  const scale = 0.72 - f * 0.22;
  const alpha = 0.85 * (1 - f);
  const tw = 56 * scale;
  const th = 26 * scale;
  ctx.globalAlpha = alpha;
  roundRect(ctx, cx - tw / 2, y - th / 2, tw, th, 7 * scale);
  ctx.strokeStyle = `rgba(${col},0.7)`;
  ctx.lineWidth = 1.2 * scale;
  ctx.stroke();
  ctx.fillStyle = `rgba(${col},0.1)`;
  ctx.fill();
  ctx.fillStyle = `rgba(${col},0.95)`;
  ctx.font = `700 ${Math.round(16 * scale)}px "Chakra Petch", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + 1);

  const timing = timingLabel(v.offsetMs);
  if (timing) {
    ctx.font = `700 ${Math.round(13 * scale)}px "Chakra Petch", sans-serif`;
    ctx.fillText(timing === "early" ? "▲" : "▼", cx + tw / 2 + 9 * scale, y + 1);
  }

  // Strum dots, left of the token: one per strum ACTUALLY PLAYED, filled when it
  // landed on the rhythmic grid (beat or half-beat) and hollow when it drifted.
  //
  // Deliberately not one dot per beat with the misses hollow: that would tell a
  // player strumming sensible half notes they missed two beats, when the app has no
  // idea what pattern the song wants (the Song model has no pattern field). And no
  // early/late marker, because on a half-beat grid "130ms late for the beat" and
  // "120ms early for the off-beat" are the same event. What can be shown honestly
  // is how many times you strummed and how many were in time.
  if (v.rhythm && v.rhythm.strums) {
    const r = v.rhythm;
    const shown = Math.min(r.strums, 8); // a very busy bar would otherwise sprawl
    const dot = 2.2 * scale;
    const step = dot * 2.8;
    const x0 = cx - tw / 2 - 10 * scale - (shown - 1) * step;
    for (let i = 0; i < shown; i++) {
      ctx.beginPath();
      ctx.arc(x0 + i * step, y + 1, dot, 0, Math.PI * 2);
      if (i < Math.min(r.onBeat, shown)) {
        ctx.fillStyle = `rgba(${col},0.9)`;
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(${col},0.45)`;
        ctx.lineWidth = 1 * scale;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
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

// Build the lyric DOM: one row per non-empty SongLine, with chord cues
// positioned above the syllable they fall on (using chordPos). A flat map
// from global chord index -> token element drives the gold highlight.
function buildLyrics() {
  const song = currentSong();
  lyricsView.innerHTML = "";
  lyricTokenEls = [];
  lyricLineOfIdx = [];
  if (!song) {
    lyricsView.hidden = true;
    return;
  }
  lyricsView.hidden = false;

  let globalIdx = 0; // running index into chordSequence
  for (const line of song.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "lyric-section";
      sec.textContent = line.section;
      lyricsView.appendChild(sec);
      continue;
    }
    if (!line.chords.length && !line.lyric.trim()) continue;

    const row = document.createElement("div");
    row.className = "lyric-line";

    if (!line.lyric.trim()) {
      // chord-only (intro/instrumental) line: render chords as bare cues
      row.classList.add("instrumental");
      line.chords.forEach((ch) => {
        const tok = document.createElement("span");
        tok.className = "lyric-tok bare";
        tok.innerHTML = `<span class="chord-cue">${escapeHtml(ch)}</span>`;
        const gi = globalIdx;
        tok.addEventListener("click", () => jumpToChord(gi));
        row.appendChild(tok);
        lyricTokenEls[gi] = tok;
        lyricLineOfIdx[gi] = row;
        globalIdx++;
      });
      lyricsView.appendChild(row);
      continue;
    }

    // lyric line: split into segments at each chord position, wrapping the
    // word starting at that position in a token that carries the cue above it.
    const lyric = line.lyric;
    // boundaries where a chord sits, sorted with their chord index
    const cuts = line.chords
      .map((ch, i) => ({ ch, i, pos: Math.min(line.chordPos[i] ?? 0, lyric.length) }))
      .sort((a, b) => a.pos - b.pos);

    let cursor = 0;
    for (let k = 0; k < cuts.length; k++) {
      const { ch, pos } = cuts[k];
      // plain text before this chord position
      if (pos > cursor) {
        row.appendChild(document.createTextNode(lyric.slice(cursor, pos)));
        cursor = pos;
      }
      // the word/run this chord cue sits over: up to the next chord cut, but
      // at least to the end of the current word (don't split mid-word visually)
      const nextPos = k + 1 < cuts.length ? cuts[k + 1].pos : lyric.length;
      let end = nextPos;
      // extend to the end of the current word so the underline glow hugs it
      const wordEnd = (() => {
        let e = pos;
        while (e < lyric.length && !/\s/.test(lyric[e])) e++;
        return e;
      })();
      if (wordEnd > end && wordEnd <= lyric.length) end = wordEnd;
      if (end <= cursor) end = Math.min(cursor + 1, lyric.length);

      const tok = document.createElement("span");
      tok.className = "lyric-tok";
      const wordText = lyric.slice(cursor, end) || "·";
      tok.innerHTML =
        `<span class="chord-cue">${escapeHtml(ch)}</span>` +
        `<span class="syll">${escapeHtml(wordText)}</span>`;
      const gi = globalIdx;
      tok.addEventListener("click", () => jumpToChord(gi));
      row.appendChild(tok);
      lyricTokenEls[gi] = tok;
      lyricLineOfIdx[gi] = row;
      globalIdx++;
      cursor = end;
    }
    // trailing text after the last chord
    if (cursor < lyric.length) {
      row.appendChild(document.createTextNode(lyric.slice(cursor)));
    }
    lyricsView.appendChild(row);
  }
  updateLyrics();
}

// Move highlight to the token at the current chord, brighten its line, autoscroll.
function updateLyrics() {
  if (!currentSong()) return;
  const curLine = lyricLineOfIdx[currentChordIdx()];
  lyricTokenEls.forEach((tok, i) => {
    if (tok) tok.classList.toggle("lit", i === currentChordIdx());
  });
  lyricsView.querySelectorAll(".lyric-line").forEach((l) => {
    l.classList.toggle("now", l === curLine);
  });
  lyricTokenEls[currentChordIdx()]?.scrollIntoView({ block: "nearest" });
}


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


// Render the target chord-tones as present/missing tokens (the "where your
// fingers are wrong" visual). Pulls the target chord's pitch classes and marks
// each present unless the detector reports it missing; appends any extras.
function renderBreakdown(reading: ChordReading | null) {
  if (!currentTarget()) {
    targetNotesEl.innerHTML = "";
    return;
  }
  const pcs = chordPitchClasses(currentTarget());
  const missingPcs = new Set((reading?.missing ?? []).map((n) => pcNameToIndex(n)));
  const active = !!reading?.active;
  let html = "";
  for (const pc of pcs) {
    const present = active && !missingPcs.has(pc);
    const cls = !active ? "" : present ? "present" : "missing";
    const mark = !active ? "" : present ? "✓" : "!";
    html += `<div class="note-tok ${cls}"><span>${PITCH_CLASSES[pc]}</span>${
      mark ? `<span class="mark">${mark}</span>` : ""
    }</div>`;
  }
  for (const ex of reading?.extra ?? []) {
    const pc = pcNameToIndex(ex);
    if (pc < 0 || pcs.includes(pc)) continue;
    html += `<div class="note-tok extra"><span>${PITCH_CLASSES[pc]}</span><span class="nm">extra</span><span class="mark">+</span></div>`;
  }
  targetNotesEl.innerHTML = html;
}

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
    for (let i = 0; i < 12; i++) {
      const v = Math.max(0, Math.min(1, c.chroma[i] || 0));
      chromaFills[i].style.height = `${(4 + v * 92).toFixed(1)}%`;
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }

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

    const nowFb = currentFretboardChord(c.detected, matched);
    const nextFb = nextFretboardChord();
    lastCurrentFretChord = drawFretboard(
      nowFb.name,
      nowFb.played,
      "Now",
      { svg: currentFretboardEl, title: currentFingerTitleEl, tag: currentFingerTagEl },
      lastCurrentFretChord
    );
    lastNextFretChord = drawFretboard(
      nextFb.name,
      nextFb.played,
      "Up Next",
      { svg: fretboardEl, title: fingerTitleEl, tag: fingerTagEl },
      lastNextFretChord
    );
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
    for (let i = 0; i < 12; i++) {
      chromaFills[i].style.height = "4%";
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }
    // flat FFT when idle
    decaySpectrum();
    const nowFb = currentFretboardChord("", false);
    const nextFb = nextFretboardChord();
    lastCurrentFretChord = drawFretboard(
      nowFb.name,
      nowFb.played,
      "Now",
      { svg: currentFretboardEl, title: currentFingerTitleEl, tag: currentFingerTagEl },
      lastCurrentFretChord
    );
    lastNextFretChord = drawFretboard(
      nextFb.name,
      nextFb.played,
      "Up Next",
      { svg: fretboardEl, title: fingerTitleEl, tag: fingerTagEl },
      lastNextFretChord
    );
  }

  tickTransport();
  updateFretboardPanelState(fretboardMatched);
  drawHighway();
  drawGauge(smoothClean, c?.active ?? false);
  drawFFT();
  requestAnimationFrame(renderChords);
}




function shapeTag(name: string, state: { index: number; count: number }, extra = ""): string {
  if (!name) return activeTuning().spelling;
  const shape = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
  return `${name}${extra} · ${shape}`;
}

function setShapeControls(
  name: string,
  controls: HTMLElement,
  countEl: HTMLElement,
  prevBtn: HTMLButtonElement,
  nextBtn: HTMLButtonElement
) {
  const state = chordShapeState(name, activeTuning());
  const canCycle = state.count > 1;
  controls.hidden = !canCycle;
  countEl.textContent = shapeLabel(state);
  prevBtn.disabled = !canCycle;
  nextBtn.disabled = !canCycle;
}

function invalidateFretboards() {
  lastCurrentFretChord = "__none__";
  lastNextFretChord = "__none__";
  lastTransitionKey = "__none__";
}

function redrawArrangementChordCards() {
  arrangementChordCards.forEach((card, name) => {
    const svg = card.querySelector(".arr-mini-fret");
    const shape = card.querySelector(".arr-card-shape");
    if (!svg || !shape) return;
    const state = chordShapeState(name, activeTuning());
    shape.textContent = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
    card.querySelectorAll<HTMLButtonElement>(".arr-shape-btn").forEach((btn) => {
      btn.disabled = state.count <= 1;
    });
    drawFretboard(
      name,
      false,
      "Up Next",
      {
        svg,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });
}

function cycleChordShape(name: string, delta: number) {
  if (!cycleShapeChoice(name, activeTuning(), delta)) return;
  invalidateFretboards();
  redrawArrangementChordCards();
  updateTransitionCoach(true);
}

// Draw baritone chord diagrams. The right rail shows two shapes at once:
// current target ("Now") and the next distinct shape ("Up Next").
let lastCurrentFretChord = "__none__";
let lastNextFretChord = "__none__";
let lastTransitionKey = "__none__";

function currentFretboardChord(detected: string, matched: boolean): { name: string; played: boolean } {
  return { name: currentTarget() || detected, played: matched };
}

function nextFretboardChord(): { name: string; played: boolean; isNext: boolean } {
  if (currentSong() && currentTarget()) {
    const next = nextDistinctChordInfo();
    if (next.name) {
      return { name: next.name, played: false, isNext: true };
    }
    return { name: "", played: false, isNext: false };
  }
  return { name: "", played: false, isNext: true };
}

currentShapePrevBtn.addEventListener("click", () => {
  cycleChordShape(currentFretboardChord(chord?.detected ?? "", false).name, -1);
});
currentShapeNextBtn.addEventListener("click", () => {
  cycleChordShape(currentFretboardChord(chord?.detected ?? "", false).name, 1);
});
nextShapePrevBtn.addEventListener("click", () => {
  cycleChordShape(nextFretboardChord().name, -1);
});
nextShapeNextBtn.addEventListener("click", () => {
  cycleChordShape(nextFretboardChord().name, 1);
});

function formatBeatDistance(beats: number): string {
  if (!Number.isFinite(beats)) return "";
  if (beats < 0.1) return "now";
  if (beats < 1) return "under 1 beat";
  return `${beats.toFixed(beats < 3 ? 1 : 0)} beats`;
}

function updateFretboardPanelState(matched: boolean) {
  const next = nextDistinctChordInfo();
  const currentName = currentFretboardChord(chord?.detected ?? "", matched).name;
  const nextGlow = next.name ? Math.max(0.12, Math.min(1, next.urgency)) : 0;
  currentFingerPanelEl.classList.toggle("is-clean", matched);
  nextFingerPanelEl.classList.toggle("has-upcoming", !!next.name);
  nextFingerPanelEl.classList.toggle("is-close", nextGlow > 0.68);
  currentFingerPanelEl.style.setProperty("--now-glow", currentSong() ? "1" : chordListening ? "0.62" : "0.35");
  nextFingerPanelEl.style.setProperty("--next-glow", nextGlow.toFixed(2));
  setShapeControls(currentName, currentShapeControlsEl, currentShapeCountEl, currentShapePrevBtn, currentShapeNextBtn);
  setShapeControls(next.name, nextShapeControlsEl, nextShapeCountEl, nextShapePrevBtn, nextShapeNextBtn);
  if (next.name) {
    const eta = isTimed() ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
    fingerTagEl.textContent = shapeTag(next.name, chordShapeState(next.name, activeTuning()), eta);
  }
  updateTransitionCoach();
}

function fretChip(fret: number | null): string {
  if (fret === null) return "x";
  return fret === 0 ? "0" : String(fret);
}

function fretHint(fret: number | null): string {
  if (fret === null) return "mute";
  return fret === 0 ? "open" : `fret ${fret}`;
}

function updateTransitionCoach(force = false) {
  const nowName = currentFretboardChord(chord?.detected ?? "", false).name;
  const next = nextDistinctChordInfo();
  const nextName = next.name;
  const nowState = chordShapeState(nowName, activeTuning());
  const nextState = chordShapeState(nextName, activeTuning());
  const eta = isTimed() && nextName ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
  const key = `${nowName}|${nowState.index}|${nextName}|${nextState.index}|${currentChordIdx()}|${eta}`;
  if (!force && key === lastTransitionKey) return;
  lastTransitionKey = key;

  if (!nowName || !nextName || !nowState.voicing || !nextState.voicing) {
    transitionTagEl.textContent = currentSong() ? "last chord" : "free play";
    transitionCoachEl.innerHTML = currentSong()
      ? `<div class="transition-empty">Stay on ${escapeHtml(nowName || "the chord")}.</div>`
      : `<div class="transition-empty">Load a song to see the next move.</div>`;
    return;
  }

  transitionTagEl.textContent = `${nowName} -> ${nextName}${eta}`;
  const actions = activeTuning().stringLabels.map((label, i) => {
    const from = nowState.voicing![i];
    const to = nextState.voicing![i];
    let kind = "move";
    let hint = `to ${fretHint(to)}`;
    if (from === to) {
      kind = "anchor";
      hint = from === null ? "muted" : "hold";
    } else if (to === null) {
      kind = "lift";
      hint = "mute";
    } else if (from === null) {
      kind = "add";
      hint = `add ${fretHint(to)}`;
    }
    return { label, from, to, kind, hint };
  });

  const anchors = actions.filter((a) => a.kind === "anchor" && a.to !== null).length;
  const changes = actions.filter((a) => a.kind !== "anchor").length;
  const headline = changes
    ? `${changes} move${changes === 1 ? "" : "s"} · ${anchors} anchor${anchors === 1 ? "" : "s"}`
    : "same shape";
  const rows = actions
    .map(
      (a) => `
        <div class="transition-string ${a.kind}">
          <span class="transition-string-name">${escapeHtml(a.label)}</span>
          <span class="transition-fret from">${fretChip(a.from)}</span>
          <span class="transition-arrow">&rarr;</span>
          <span class="transition-fret to">${fretChip(a.to)}</span>
          <span class="transition-hint">${escapeHtml(a.hint)}</span>
        </div>`
    )
    .join("");

  transitionCoachEl.innerHTML = `
    <div class="transition-summary">${escapeHtml(headline)}</div>
    <div class="transition-strings">${rows}</div>`;
}

function drawFretboard(
  name: string,
  played: boolean,
  label: "Now" | "Up Next",
  els: { svg: Element; title: Element; tag: Element },
  lastKey: string
): string {
  const state = chordShapeState(name, activeTuning());
  const key = `${label}|${name}|${played}|${state.index}|${state.count}|${state.voicing ? voicingKey(state.voicing) : "none"}`;
  if (key === lastKey) return lastKey;

  // verified shape first; fall back to a generated one for chords not in the
  // hand-checked table (so MIDI-derived exotics still get a diagram)
  const voicing = state.voicing;
  const accent = played ? "#19e3c4" : "#f5c451";
  const glow = played ? "rgba(25,227,196,0.6)" : "rgba(245,196,81,0.5)";
  const dim = "#2b4440";

  // geometry: 4 strings (cols), 4 frets (rows)
  const nS = 4,
    nF = 4;
  const x0 = 28,
    y0 = 40,
    w = 94,
    h = 120;
  const dx = w / (nS - 1);
  const dy = h / nF;

  els.title.textContent = label;
  if (!voicing) {
    els.svg.innerHTML = `<text x="75" y="105" fill="${dim}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">no diagram</text>`;
    els.tag.textContent = name ? `${name} · ${activeTuning().spelling}` : activeTuning().spelling;
    return key;
  }
  els.tag.textContent = shapeTag(name, state);

  // If the shape sits high on the neck, show a window of nF frets starting at
  // baseFret (with a position label) instead of always frets 0–4 from the nut.
  const fretted = voicing.filter((f): f is number => f !== null && f > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const baseFret = maxFret > nF ? Math.max(...fretted, 1) - (nF - 1) : 1;
  const openNut = baseFret === 1; // draw a thick nut only in open position

  const parts: string[] = [];
  // nut (thick at open position) or position label
  if (openNut) {
    parts.push(`<rect x="${x0 - 1}" y="${y0 - 4}" width="${w + 2}" height="4" fill="${dim}"/>`);
  } else {
    parts.push(`<text x="${x0 - 12}" y="${y0 + dy / 2 + 4}" fill="${accent}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">${baseFret}</text>`);
  }
  // fret lines
  for (let f = 0; f <= nF; f++) {
    const y = y0 + f * dy;
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${dim}" stroke-width="1"/>`);
  }
  // strings + labels + markers
  for (let s = 0; s < nS; s++) {
    const x = x0 + s * dx;
    parts.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + h}" stroke="${dim}" stroke-width="1.2"/>`);
    parts.push(`<text x="${x}" y="${y0 + h + 18}" fill="${dim}" font-size="11" font-family="Chakra Petch, sans-serif" text-anchor="middle">${activeTuning().stringLabels[s]}</text>`);

    const fret = voicing[s];
    if (fret === null) {
      parts.push(`<text x="${x}" y="${y0 - 8}" fill="${accent}" font-size="12" font-family="JetBrains Mono, monospace" text-anchor="middle">×</text>`);
    } else if (fret === 0) {
      parts.push(`<circle cx="${x}" cy="${y0 - 12}" r="4.5" fill="none" stroke="${accent}" stroke-width="1.6"/>`);
    } else {
      const rel = fret - baseFret + 1; // 1-based row within the visible window
      const y = y0 + (rel - 0.5) * dy;
      parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${accent}" style="filter:drop-shadow(0 0 6px ${glow})"/>`);
    }
  }
  els.svg.innerHTML = parts.join("");
  return key;
}



requestAnimationFrame(renderChords);

initStrumCam({
  isActiveView: () => currentMode() === "strumcam",
  setMicActive: (on) => {
    chordListening = on;
    syncKeepAwake();
  },
});
