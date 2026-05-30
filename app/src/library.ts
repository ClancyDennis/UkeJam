// Song library — persists pasted songs. localStorage for now (simple, works
// offline); can move to SQLite / Tauri fs later to match the prototype's db.py.

import { parseSong, type Song } from "./song";

export interface SongRecord {
  id: string;
  title: string;
  artist: string;
  source: string; // raw pasted text (source of truth, re-parsable)
  created: number;
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

function save(records: SongRecord[]) {
  localStorage.setItem(KEY, JSON.stringify(records));
}

export function listSongs(): SongRecord[] {
  return load().sort((a, b) => a.title.localeCompare(b.title));
}

export function addSong(
  source: string,
  overrides?: { title?: string; artist?: string }
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
