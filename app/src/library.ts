// Song library — persists saved songs. The durable store is a JSON file in
// the app data dir, written through the Rust `library_load`/`library_save`
// commands: webview localStorage has a ~5 MB quota (inline base64 MIDIs blow
// past it) and on iOS the OS can evict it under disk pressure. localStorage
// survives as (a) the one-time migration source for pre-existing libraries
// and (b) the fallback store when running without the Tauri runtime (`pnpm
// dev` in a plain browser tab).

import { invoke } from "@tauri-apps/api/core";
import { parseSong, type Song } from "./song";

// A backing track imported from MIDI: the raw file (base64) plus a per-channel
// summary so the player can pick which instruments sound (e.g. bass + drums).
export interface BackingTrackInfo {
  channel: number;
  name: string;
  noteCount: number;
  isDrums: boolean;
  isBass: boolean;
}
export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  source: string; // raw pasted text (source of truth, re-parsable)
  created: number;
  midi?: string; // base64 of the original MIDI (for backing playback), if imported
  tracks?: BackingTrackInfo[]; // playable channels in that MIDI
}

const KEY = "ukejam.library.v1";
const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function loadLocal(): SongRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SongRecord[]) : [];
  } catch {
    return [];
  }
}

// In-memory working set; seeded from localStorage so the API can stay
// synchronous, then replaced by the native store once `libraryReady` resolves.
let records: SongRecord[] = loadLocal();

// Resolves once the durable store has been read (and any localStorage library
// migrated into it). The UI re-renders the song list when this settles.
export const libraryReady: Promise<void> = (async () => {
  if (!native) return;
  try {
    const stored = await invoke<string | null>("library_load");
    if (stored !== null) {
      records = JSON.parse(stored) as SongRecord[];
    } else if (records.length) {
      // First run after the localStorage era: promote the old library. The
      // localStorage copy is left in place as a safety net.
      await invoke("library_save", { json: JSON.stringify(records) });
    }
  } catch (e) {
    console.warn("library: native store unavailable, staying on localStorage", e);
  }
})();

// Thrown when localStorage rejects the write (usually the ~5 MB quota — base64
// MIDIs are stored inline, so a few large imports can hit it). Only reachable
// on the browser fallback; the native file store has no such quota.
export class LibraryFullError extends Error {
  constructor() {
    super("library storage is full (large MIDI imports use a lot of space)");
    this.name = "LibraryFullError";
  }
}

function save() {
  if (native) {
    // Write-through; the Rust side writes atomically. Failures are logged
    // rather than thrown — the in-memory copy stays correct for this session.
    invoke("library_save", { json: JSON.stringify(records) }).catch((e) =>
      console.error("library save failed", e)
    );
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // QuotaExceededError (and Safari's variant) land here; treat any setItem
    // failure as "full" so the caller can report it.
    throw new LibraryFullError();
  }
}

export function listSongs(): SongRecord[] {
  return [...records].sort((a, b) => a.title.localeCompare(b.title));
}

export function addSong(
  source: string,
  overrides?: { title?: string; artist?: string; midi?: string; tracks?: BackingTrackInfo[] }
): SongRecord {
  const parsed = parseSong(source);
  // explicit fields win; otherwise fall back to any {title:}/{artist:} in text
  const title = overrides?.title?.trim() || parsed.title;
  const artist = overrides?.artist?.trim() || parsed.artist;
  const rec: SongRecord = {
    // id without Date.now()/random in the hot path isn't a concern here (UI action)
    id: `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    title,
    artist,
    source,
    created: Date.now(),
    midi: overrides?.midi,
    tracks: overrides?.tracks,
  };
  records.push(rec);
  save();
  return rec;
}

export function renameSong(id: string, title: string, artist: string) {
  const rec = records.find((r) => r.id === id);
  if (rec) {
    rec.title = title.trim() || rec.title;
    rec.artist = artist.trim();
    save();
  }
}

export function deleteSong(id: string) {
  records = records.filter((r) => r.id !== id);
  save();
}

export function getSong(id: string): Song | null {
  const rec = records.find((r) => r.id === id);
  return rec ? parseSong(rec.source) : null;
}
