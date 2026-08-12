// =====================================================================
// Library + the add-a-song form
// =====================================================================
// Paste a tab, import a MIDI, or pull a sheet in from tab search — all three
// converge on addSong() so storage, parser, strip and highway just work and the
// song stays editable. Optional ✨ AI enhance tidies a messy tab or lays lyrics
// over a timed chart before it is saved; a failure there is always survivable,
// and the un-enhanced chart is saved rather than nothing.

import { invokeAiConfig } from "../ai.ts";
import { escapeHtml } from "../dom.ts";
import { nativeInvoke } from "../native.ts";
import {
  addSong,
  deleteSong,
  libraryReady,
  listSongs,
  renameSong,
  LibraryFullError,
  type SongRecord,
} from "../library.ts";
import { buildFusedChordPro, parseChordChart } from "../midi.ts";
import { aiConfig, aiConfigReady, aiEnhanceProblem } from "./setup/aiSettings.ts";
import { currentMode } from "../state/appMode.ts";
import { clearMidiStaging, initMidiImport, stagedMidi } from "./midiImport.ts";
import { initTabSearch } from "./tabSearch.ts";

export interface LibraryViewDeps {
  /// Make this song the one being practised. Spans every practice view, so the
  /// orchestration lives above this screen.
  loadSongIntoPlay: (rec: SongRecord) => void;
}

let deps: LibraryViewDeps;
let pasteBox: HTMLTextAreaElement;
let songTitleInput: HTMLInputElement;
let songArtistInput: HTMLInputElement;
let addSongBtn: HTMLButtonElement;
let lyricsBox: HTMLTextAreaElement;
let aiEnhanceToggle: HTMLInputElement;
let libAddStatus: HTMLElement;
let songListEl: HTMLElement;
let libCountEl: HTMLElement;

/// Say something in the add-a-song status line. Also used by the MIDI importer,
/// which writes into this same form.
export function setLibraryStatus(text: string, done = false): void {
  libAddStatus.classList.toggle("done", done);
  libAddStatus.textContent = text;
}

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


async function onAddSong() {
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
  deps.loadSongIntoPlay(rec);
}

export function renderSongList() {
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
      deps.loadSongIntoPlay(s);
    });
    songListEl.appendChild(row);
  }
}

// The list renders from the in-memory library, which starts on the
// localStorage seed; refresh it once the durable native store has loaded.

export function initLibraryView(d: LibraryViewDeps): void {
  deps = d;
  pasteBox = document.getElementById("paste-box") as HTMLTextAreaElement;
  songTitleInput = document.getElementById("song-title") as HTMLInputElement;
  songArtistInput = document.getElementById("song-artist") as HTMLInputElement;
  addSongBtn = document.getElementById("add-song-btn") as HTMLButtonElement;
  lyricsBox = document.getElementById("lyrics-box") as HTMLTextAreaElement;
  aiEnhanceToggle = document.getElementById("ai-enhance") as HTMLInputElement;
  libAddStatus = document.getElementById("lib-add-status")!;
  songListEl = document.getElementById("song-list")!;
  libCountEl = document.getElementById("lib-count")!;

  addSongBtn.addEventListener("click", () => void onAddSong());

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

  // The list renders from the in-memory library, which starts on the
  // localStorage seed; refresh it once the durable native store has loaded.
  void libraryReady.then(() => {
    if (currentMode() === "library") renderSongList();
  });
}

