// Song library — persists pasted songs. localStorage for now (simple, works
// offline); can move to SQLite / Tauri fs later to match the prototype's db.py.

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

function load(): SongRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SongRecord[]) : [];
  } catch {
    return [];
  }
}

// Thrown when localStorage rejects the write (usually the ~5 MB quota — base64
// MIDIs are stored inline, so a few large imports can hit it). Callers surface
// this to the user instead of silently dropping the save.
export class LibraryFullError extends Error {
  constructor() {
    super("library storage is full (large MIDI imports use a lot of space)");
    this.name = "LibraryFullError";
  }
}

function save(records: SongRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch (e) {
    // QuotaExceededError (and Safari's variant) land here; treat any setItem
    // failure as "full" so the caller can report it.
    throw new LibraryFullError();
  }
}

export function listSongs(): SongRecord[] {
  return load().sort((a, b) => a.title.localeCompare(b.title));
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
  const records = load();
  records.push(rec);
  save(records);
  return rec;
}

export function renameSong(id: string, title: string, artist: string) {
  const records = load();
  const rec = records.find((r) => r.id === id);
  if (rec) {
    rec.title = title.trim() || rec.title;
    rec.artist = artist.trim();
    save(records);
  }
}

export function deleteSong(id: string) {
  save(load().filter((r) => r.id !== id));
}

export function getSong(id: string): Song | null {
  const rec = load().find((r) => r.id === id);
  return rec ? parseSong(rec.source) : null;
}
