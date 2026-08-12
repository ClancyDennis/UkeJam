// Chord names and the pitch classes they sound. Pure: no DOM, no app state.
//
// The gradeable vocabulary here is shared with TARGET_QUALITIES in chords.rs.
// Both sides must agree, because a chord the frontend can parse but Rust cannot
// (or vice versa) leaves the detector holding no target — and downstream, an
// empty missing/extra diff is indistinguishable from a flawless chord.
//
// Pinned by verify-theory.mjs.

export const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// minimal chord -> pitch-class map for the chromagram target highlight
// Normalize the many ways tabs write a chord into our canonical name:
// flat roots -> sharps, quality aliases (m7-5/ø -> m7b5, °->dim, +->aug, maj->"")
// and strip slash-bass (D/F# -> D) for fingering/diagram purposes.
const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#",
};

export function normalizeChord(name: string): string {
  if (!name) return "";
  let n = name.trim().split("/")[0].trim(); // drop slash bass
  const m = n.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return n;
  let root = m[1] + (m[2] ?? "");
  if (FLAT_TO_SHARP[root]) root = FLAT_TO_SHARP[root];
  let q = m[3].trim();
  // quality aliases
  q = q
    .replace(/^maj$/i, "")
    .replace(/^M$/, "")
    .replace(/^(min|−|-)/, "m")
    .replace(/m7[-b]5/i, "m7b5")
    .replace(/ø7?/i, "m7b5")
    .replace(/°7/i, "dim7")
    .replace(/(°|dim)$/i, "dim")
    .replace(/\+/, "aug")
    .replace(/^maj7/i, "maj7")
    .replace(/^M7/, "maj7");
  return root + q;
}

export function chordPitchClasses(rawName: string): number[] {
  const name = normalizeChord(rawName);
  if (!name) return [];
  const m = name.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return [];
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let root = base[m[1]];
  if (m[2] === "#") root = (root + 1) % 12;
  if (m[2] === "b") root = (root + 11) % 12;
  const q = m[3];
  const intervals: Record<string, number[]> = {
    "": [0, 4, 7],
    m: [0, 3, 7],
    "7": [0, 4, 7, 10],
    maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10],
    sus2: [0, 2, 7],
    sus4: [0, 5, 7],
    dim: [0, 3, 6],
    dim7: [0, 3, 6, 9],
    aug: [0, 4, 8],
    m7b5: [0, 3, 6, 10],
    "6": [0, 4, 7, 9],
    m6: [0, 3, 7, 9],
    add9: [0, 4, 7, 2],
    "7sus4": [0, 5, 7, 10],
    "5": [0, 7],
  };
  // An unrecognized quality returns [] rather than guessing a major triad.
  // Guessing meant "Gx" (a typo, or a tab's "x4" repeat marker glued to a
  // chord) silently became G — the chromagram highlighted G's notes, the
  // fretboard drew a G, and none of it was in the chart. Keep this in step with
  // TARGET_QUALITIES in chords.rs; both are the gradeable vocabulary.
  const iv = intervals[q];
  if (!iv) return [];
  return [...new Set(iv.map((x) => (root + x) % 12))];
}

/// Pitch class of a bare note name ("F#", "Bb"), ignoring any quality after it.
/// -1 when the name doesn't start with a note letter.
export function pcNameToIndex(name: string): number {
  if (!name) return -1;
  const m = name.trim().match(/^([A-G])(#|b)?/);
  if (!m) return -1;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1]];
  if (m[2] === "#") pc = (pc + 1) % 12;
  if (m[2] === "b") pc = (pc + 11) % 12;
  return pc;
}

export function positiveMod(n: number, d: number): number {
  return ((n % d) + d) % d;
}
