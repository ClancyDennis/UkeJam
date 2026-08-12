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
import { buildSongStrip, initStrip, updateStrip } from "./views/play/strip";
import { buildLyrics, initLyrics, updateLyrics } from "./views/play/lyrics";
import { drawHighway, initHighway } from "./views/play/highway";
import {
  drawFretboard,
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
  backingTrackList,
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
  nextDistinctChordInfo,
  resetScoring,
  restartTransport,
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

// --- arrangement view state ---
// Element lists the arrangement screen rebuilds when a song loads, so
// currentChordIdx() -> {chord, line, card} stays O(1).
let arrangementChordEls: HTMLElement[] = [];
let arrangementLineOfIdx: HTMLElement[] = [];
let arrangementChordCards = new Map<string, HTMLElement>();
let lastArrangementScrollIdx = -1;

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
  onChordIndexChanged: () => {
    updateStrip();
    updateLyrics();
    updateArrangementState();
    updatePracticeUi();
  },
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
    for (let i = 0; i < 12; i++) {
      chromaFills[i].style.height = "4%";
      chromaBars[i].classList.toggle("target", targetPcs.includes(i));
    }
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




requestAnimationFrame(renderChords);

initStrumCam({
  isActiveView: () => currentMode() === "strumcam",
  setMicActive: (on) => {
    chordListening = on;
    syncKeepAwake();
  },
});
