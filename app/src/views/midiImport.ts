// --- MIDI import: a .mid becomes a timed chord chart in the library ---
// We extract a chord-per-bar timeline (with tempo + bar markers) and feed the
// resulting ChordPro text through the same addSong() path as a pasted tab, so
// storage / parser / strip / highway all just work and it stays editable.
//
// This module owns the staged import: the parsed MIDI being reviewed, the
// chord-channel selection, and the raw bytes the Add step saves as a backing
// track. The add-a-song form lends it the fields it writes into.

import {
  channelChordScores,
  midiToChordChart,
  parseChordChart,
  parseMidi,
  suggestChordChannels,
  titleFromFilename,
  type MidiData,
} from "../midi.ts";
import type { BackingTrackInfo } from "../library.ts";
import { escapeHtml } from "../dom.ts";

export interface StagedMidi {
  b64: string;
  tracks: BackingTrackInfo[];
}

export interface MidiImportDeps {
  /// The add-a-song form's fields. Owned by the library view, written here.
  pasteBox: HTMLTextAreaElement;
  titleInput: HTMLInputElement;
  artistInput: HTMLInputElement;
  /// Shown once a timed chart exists, so lyrics can be laid over it.
  lyricsBox: HTMLTextAreaElement;
  setStatus: (text: string, done?: boolean) => void;
}

let deps: MidiImportDeps;
let loadMidiBtn: HTMLButtonElement;
let midiInput: HTMLInputElement;
let chanPickerEl: HTMLElement;
let chanChipsEl: HTMLElement;

// the parsed MIDI currently being reviewed (for the channel picker)
let importedMidi: MidiData | null = null;
let chordChannelSel: number[] | null = null;
// the raw MIDI staged for the Add step to save as a backing track
let pendingMidi: StagedMidi | null = null;

/// The MIDI staged for the current draft, if any — the Add step saves this
/// alongside the chart so the song gets a backing track.
export function stagedMidi(): StagedMidi | null {
  return pendingMidi;
}

export function clearMidiStaging(): void {
  pendingMidi = null;
  importedMidi = null;
  chordChannelSel = null;
  chanPickerEl.hidden = true;
  deps.lyricsBox.hidden = true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// Build the channel chips for the imported MIDI; each shows the instrument
// name + a chordality score (higher = more chord-like). Toggling re-derives.
function buildChannelPicker() {
  if (!importedMidi) return;
  const scores = channelChordScores(importedMidi);
  chanChipsEl.innerHTML = "";
  // channels that actually sound notes (skip drums — never chords)
  const chans = importedMidi.tracks.filter((t) => !t.isDrums);
  if (!chans.length) {
    chanPickerEl.hidden = true;
    return;
  }
  for (const t of chans) {
    const on = chordChannelSel === null || chordChannelSel.includes(t.channel);
    const chip = document.createElement("button");
    chip.className = "chan-chip" + (on ? " on" : "");
    const sc = scores.get(t.channel) ?? 0;
    chip.innerHTML = `${escapeHtml(t.name)}<span class="ch-score">${sc.toFixed(1)}</span>`;
    chip.title = `${sc >= 1.5 ? "chordal" : "melodic / single-note"} — ${t.noteCount} notes`;
    chip.addEventListener("click", () => {
      // null means "all"; materialize to an explicit list on first toggle
      if (chordChannelSel === null) {
        chordChannelSel = chans.map((c) => c.channel);
      }
      if (chordChannelSel.includes(t.channel)) {
        chordChannelSel = chordChannelSel.filter((c) => c !== t.channel);
      } else {
        chordChannelSel.push(t.channel);
      }
      if (!chordChannelSel.length) chordChannelSel = null; // none -> treat as all
      buildChannelPicker();
      rederiveChart();
    });
    chanChipsEl.appendChild(chip);
  }
  chanPickerEl.hidden = false;
}

// Re-derive the chord chart text from the imported MIDI + current channel
// selection and drop it into the paste box (without clearing the staging).
function rederiveChart() {
  if (!importedMidi) return;
  const chart = midiToChordChart(importedMidi, {
    title: deps.titleInput.value.trim() || undefined,
    artist: deps.artistInput.value.trim() || undefined,
    collapseRuns: false,
    chordChannels: chordChannelSel,
  });
  // set value directly (programmatic set doesn't fire 'input', so staging stays)
  deps.pasteBox.value = chart;
  const bars = parseChordChart(chart).bars.length;
  const src =
    chordChannelSel === null
      ? "all parts"
      : chordChannelSel.length === 1
        ? importedMidi.tracks.find((t) => t.channel === chordChannelSel![0])?.name ??
          `ch${chordChannelSel[0] + 1}`
        : `${chordChannelSel.length} parts`;
  deps.setStatus(
    `${importedMidi.tempoBpm} bpm · ${bars} bars · chords from ${src} — review, then Add`,
    true
  );
}

export function initMidiImport(d: MidiImportDeps): void {
  deps = d;
  loadMidiBtn = document.getElementById("load-midi-btn") as HTMLButtonElement;
  midiInput = document.getElementById("midi-input") as HTMLInputElement;
  chanPickerEl = document.getElementById("chan-picker")!;
  chanChipsEl = document.getElementById("chan-chips")!;

  // dropping the imported chart text invalidates the staged MIDI association
  deps.pasteBox.addEventListener("input", () => {
    if (pendingMidi || importedMidi) clearMidiStaging();
  });

  loadMidiBtn.addEventListener("click", () => midiInput.click());

  midiInput.addEventListener("change", async () => {
    const file = midiInput.files?.[0];
    if (!file) return;
    deps.setStatus(`♪ reading ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const data = parseMidi(buf);
      const named = titleFromFilename(file.name);
      importedMidi = data;
      // auto-pick the chord channels (a default; the user can change it below).
      chordChannelSel = suggestChordChannels(data);
      if (!deps.titleInput.value.trim()) deps.titleInput.value = named.title;
      if (!deps.artistInput.value.trim()) deps.artistInput.value = named.artist;
      // stage the raw MIDI + track list so Add saves a backing track with it
      pendingMidi = { b64: bytesToBase64(buf), tracks: data.tracks };
      buildChannelPicker();
      deps.lyricsBox.hidden = false; // offer to lay lyrics over the timed chart
      rederiveChart();
    } catch (e) {
      deps.setStatus(`couldn't read MIDI: ${e}`);
    } finally {
      midiInput.value = ""; // allow re-selecting the same file
    }
  });
}
