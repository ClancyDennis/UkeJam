// Chord shapes: the hand-verified tables, the fallback shape generator, and
// which shape of a chord the player is currently looking at.
//
// Pure given a chord name and a tuning — no DOM, no app state beyond the shape
// the user last cycled to. Pinned by verify-voicings.mjs (every hand-written
// shape sounds exactly its chord tones) and verify-theory.mjs (the generator
// obeys the same rule).

import { chordPitchClasses, normalizeChord, positiveMod } from "./chords.ts";
import type { TuningSpec } from "../tunings.ts";

export type Voicing = (number | null)[];

// Verified baritone (D-G-B-E) voicings: fret per string [D, G, B, E];
// null = string not played. Every shape is checked to produce the correct
// chord tones (see the generator in the prototype). Covers all 12 majors,
// minors, plus common 7ths/maj7s/m7s.
export const BARITONE_VOICINGS: Record<string, Voicing> = {
  C: [2, 0, 1, 0],
  "C#": [null, 1, 2, 1],
  D: [0, 2, 3, 2],
  "D#": [1, 3, 4, 3],
  E: [2, 1, 0, 0],
  F: [3, 2, 1, 1],
  "F#": [4, 3, 2, 2],
  G: [0, 0, 0, 3],
  "G#": [1, 1, 1, 4],
  A: [2, 2, 2, 0],
  "A#": [3, 3, 3, 1],
  B: [4, 4, 4, 2],
  Cm: [1, 0, 1, null],
  "C#m": [null, 1, 2, 0],
  Dm: [0, 2, 3, 1],
  "D#m": [1, 3, 4, 2],
  Em: [2, 0, 0, 0],
  Fm: [3, 1, 1, 1],
  "F#m": [4, 2, 2, 2],
  Gm: [0, 3, null, 3],
  "G#m": [1, 1, 0, null],
  Am: [2, 2, 1, 0],
  "A#m": [3, 3, 2, 1],
  Bm: [4, 4, 3, 2],
  C7: [2, 3, 1, 3],
  D7: [0, 2, 1, 2],
  E7: [0, 1, 0, 0],
  G7: [0, 0, 0, 1],
  A7: [2, 2, 2, 3],
  B7: [1, 2, 0, 2],
  Dm7: [0, 2, 1, 1],
  Em7: [0, 0, 0, 0],
  Am7: [2, 2, 1, 3],
  Cmaj7: [5, 5, 0, 0],
  Dmaj7: [0, 2, 2, 2],
  Fmaj7: [3, 2, 1, 0],
  Gmaj7: [0, 0, 0, 2],
  // exotic qualities found in real tabs (e.g. F#m7-5 in Foo Fighters "The
  // Pretender"). All shapes verified to produce the correct chord tones.
  Cm7b5: [1, 3, 1, 2], Cdim: [1, null, 1, 2], Cdim7: [1, 2, 1, 2], Caug: [null, 1, 1, 0],
  Csus2: [0, 0, 1, null], Csus4: [null, 0, 1, 1], C6: [5, 5, 5, 5], Cm6: [5, 5, 4, 5],
  Cadd9: [0, 0, 1, 0], C7sus4: [5, 5, 6, 6],
  "C#m7b5": [5, 6, 0, 0], "C#dim": [2, 0, 2, 0], "C#dim7": [2, 3, 2, 3], "C#aug": [null, 2, 2, 1],
  "C#sus2": [1, 1, 2, null], "C#sus4": [null, 1, 2, 2], "C#6": [6, 6, 6, 6], "C#m6": [6, 6, 5, 6],
  "C#add9": [1, 1, 2, 1], "C#7sus4": [6, 6, 7, 7],
  Dm7b5: [0, 1, 1, 1], Ddim: [0, 1, null, 1], Ddim7: [0, 1, 0, 1], Daug: [0, 3, 3, 2],
  Dsus2: [0, 2, null, 0], Dsus4: [0, 0, null, 5], D6: [0, 2, 0, 2], Dm6: [0, 2, 0, 1],
  Dadd9: [7, 7, 7, 0], D7sus4: [0, 2, 1, 3],
  "D#m7b5": [1, 2, 2, 2], "D#dim": [1, 2, null, 2], "D#dim7": [1, 2, 1, 2], "D#aug": [1, 0, 0, null],
  "D#sus2": [3, 3, 4, null], "D#sus4": [null, 3, 4, 4], "D#6": [1, 3, 1, 3], "D#m6": [1, 3, 1, 2],
  "D#add9": [3, 3, 4, 3], "D#7sus4": [6, 6, 4, 6],
  Em7b5: [0, 0, 5, 6], Edim: [5, 0, 5, 6], Edim7: [2, 3, 2, 3], Eaug: [null, 1, 1, 0],
  Esus2: [4, 4, 0, 0], Esus4: [2, 2, 0, 0], E6: [6, 6, 0, 0], Em6: [5, 6, 0, 0],
  Eadd9: [2, 1, 0, 2], E7sus4: [0, 2, 0, 0],
  Fm7b5: [1, 1, 0, 1], Fdim: [null, 1, 0, 1], Fdim7: [0, 1, 0, 1], Faug: [null, 2, 2, 1],
  Fsus2: [null, 0, 1, 1], Fsus4: [null, 5, 6, 6], F6: [0, 2, 1, 1], Fm6: [0, 1, 1, 1],
  Fadd9: [5, 5, 6, 5], F7sus4: [1, 3, 1, 1],
  "F#m7b5": [2, 2, 1, 2], "F#dim": [null, 2, 1, 2], "F#dim7": [1, 2, 1, 2], "F#aug": [0, 3, 3, 2],
  "F#sus2": [null, 1, 2, 2], "F#sus4": [null, 6, 7, 7], "F#6": [1, 3, 2, 2], "F#m6": [1, 2, 2, 2],
  "F#add9": [6, 6, 7, 6], "F#7sus4": [2, 4, 2, 2],
  Gm7b5: [3, 3, 2, 3], Gdim: [null, 3, 2, 3], Gdim7: [2, 3, 2, 3], Gaug: [1, 0, 0, null],
  Gsus2: [0, 0, null, 5], Gsus4: [0, 0, 1, null], G6: [0, 0, 0, 0], Gm6: [0, 0, 5, 6],
  Gadd9: [0, 0, 0, 5], G7sus4: [0, 0, 1, 1],
  "G#m7b5": [0, 1, 0, 2], "G#dim": [0, 4, 0, 4], "G#dim7": [0, 1, 0, 1], "G#aug": [null, 1, 1, 0],
  "G#sus2": [null, 3, 4, 4], "G#sus4": [1, 1, 2, null], "G#6": [1, 1, 1, 1], "G#m6": [1, 1, 0, 1],
  "G#add9": [6, 5, 4, 6], "G#7sus4": [1, 1, 2, 2],
  Am7b5: [5, 5, 4, 5], Adim: [1, 2, 1, null], Adim7: [1, 2, 1, 2], Aaug: [null, 2, 2, 1],
  Asus2: [2, 2, 0, 0], Asus4: [0, 2, null, 0], A6: [2, 2, 2, 2], Am6: [2, 2, 1, 2],
  Aadd9: [7, 6, 0, 0], A7sus4: [0, 0, 5, 5],
  "A#m7b5": [6, 6, 5, 6], "A#dim": [2, 3, 2, 0], "A#dim7": [2, 3, 2, 3], "A#aug": [0, 3, 3, 2],
  "A#sus2": [null, 5, 6, 6], "A#sus4": [3, 3, 4, null], "A#6": [0, 0, 6, 6], "A#m6": [3, 3, 2, 3],
  "A#add9": [0, 5, 6, 6], "A#7sus4": [3, 3, 4, 4],
  Bm7b5: [0, 2, 0, 1], Bdim: [0, null, 0, 1], Bdim7: [0, 1, 0, 1], Baug: [1, 0, 0, null],
  Bsus2: [null, 6, 7, 7], Bsus4: [4, 4, 0, 0], B6: [4, 4, 4, 4], Bm6: [0, 1, 0, 2],
  Badd9: [1, 4, 2, 2], B7sus4: [2, 2, 0, 2],
};

// Standard G-C-E-A voicings: fret per string [G, C, E, A]. These are the
// shapes ukulele players actually learn, so they're worth pinning rather than
// leaving to the generator (which optimises for coverage and low frets, not
// familiarity — it would offer a technically-correct C that nobody plays).
// Every shape here is checked against the chord's pitch classes by
// `voicingsCoverChordTones` in the test below. Qualities beyond this set fall
// through to the generator, which follows whatever tuning is active.
export const STANDARD_VOICINGS: Record<string, Voicing> = {
  C: [0, 0, 0, 3],
  "C#": [1, 1, 1, 4],
  D: [2, 2, 2, 0],
  "D#": [3, 3, 3, 1],
  E: [1, 4, 0, 2],
  F: [2, 0, 1, 0],
  "F#": [3, 1, 2, 1],
  G: [0, 2, 3, 2],
  "G#": [5, 3, 4, 3],
  A: [2, 1, 0, 0],
  "A#": [3, 2, 1, 1],
  B: [4, 3, 2, 2],
  Cm: [0, 3, 3, 3],
  "C#m": [1, 4, 4, 4],
  Dm: [2, 2, 1, 0],
  "D#m": [3, 3, 2, 1],
  Em: [0, 4, 3, 2],
  Fm: [1, 0, 1, 3],
  "F#m": [2, 1, 2, 0],
  Gm: [0, 2, 3, 1],
  "G#m": [1, 3, 4, 2],
  Am: [2, 0, 0, 0],
  "A#m": [3, 1, 1, 1],
  Bm: [4, 2, 2, 2],
  C7: [0, 0, 0, 1],
  "C#7": [1, 1, 1, 2],
  D7: [2, 2, 2, 3],
  "D#7": [3, 3, 3, 4],
  E7: [1, 2, 0, 2],
  F7: [2, 3, 1, 3],
  "F#7": [3, 4, 2, 4],
  G7: [0, 2, 1, 2],
  "G#7": [1, 3, 2, 3],
  A7: [0, 1, 0, 0],
  "A#7": [1, 2, 1, 1],
  B7: [2, 3, 2, 2],
  Cm7: [3, 3, 3, 3],
  Dm7: [2, 2, 1, 3],
  Em7: [0, 2, 0, 2],
  Fm7: [1, 3, 1, 3],
  Gm7: [0, 2, 1, 1],
  Am7: [0, 0, 0, 0],
  Bm7: [2, 2, 2, 2],
  Cmaj7: [0, 0, 0, 2],
  Dmaj7: [2, 2, 2, 4],
  Emaj7: [1, 3, 0, 2],
  Fmaj7: [2, 4, 1, 3],
  Gmaj7: [0, 2, 2, 2],
  Amaj7: [1, 1, 0, 0],
  Csus2: [0, 2, 3, 3],
  Csus4: [0, 0, 1, 3],
  Dsus4: [0, 2, 3, 0],
  Esus4: [4, 4, 0, 0],
  Fsus2: [0, 0, 1, 3],
  Gsus4: [0, 2, 3, 3],
  Asus2: [2, 4, 5, 2],
  Asus4: [2, 2, 0, 0],
  C6: [0, 0, 0, 0],
  D6: [2, 2, 2, 2],
  F6: [2, 2, 1, 3],
  G6: [0, 2, 0, 2],
  A6: [2, 4, 2, 4],
  Am6: [2, 4, 2, 3],
  Dm6: [2, 2, 1, 2],
  Em6: [0, 1, 0, 2],
  Cadd9: [0, 2, 0, 3],
  Dadd9: [2, 4, 2, 5],
  Gadd9: [2, 2, 3, 2],
  Cdim: [5, 3, 2, 3],
  Ddim: [1, 2, 1, 5],
  Edim: [0, 4, 0, 1],
  Fdim: [4, 5, 4, 2],
  Gdim: [0, 1, 3, 1],
  Adim: [5, 3, 5, 0],
  Bdim: [4, 2, 1, 2],
  Caug: [1, 0, 0, 3],
  Daug: [3, 2, 2, 1],
  Eaug: [1, 0, 0, 3],
  Faug: [2, 1, 1, 0],
  Gaug: [0, 3, 3, 2],
  Aaug: [2, 1, 1, 0],
  Am7b5: [2, 3, 3, 3],
  Bm7b5: [2, 2, 1, 2],
  Cm7b5: [3, 3, 2, 3],
  Dm7b5: [1, 2, 1, 3],
  Em7b5: [0, 2, 0, 1],
  "F#m7b5": [2, 4, 2, 3],
};

/// The given tuning's verified table, keyed by normalized chord name.
export function verifiedVoicings(tuning: TuningSpec): Record<string, Voicing> {
  return tuning.id === "baritone" ? BARITONE_VOICINGS : STANDARD_VOICINGS;
}


// Fallback voicing generator: when a chord isn't in the verified VOICINGS
// table (e.g. F#maj7 and many 7th/m7 qualities the MIDI import surfaces),
// derive a playable shape. For each string we list the fret that lands on each
// chord tone (within a low window), then search the small space of one-pick-
// per-string combinations for a shape that covers EVERY chord tone, preferring
// open strings, low frets, and a tight span. Greedy lowest-fret-per-string
// fails (it can grab a different tone and never cover the root/3rd), so we
// search. Verified to only ever show chord tones.
const MAX_FRET = 7;
export function voicingKey(v: Voicing): string {
  return v.map((f) => (f === null ? "x" : String(f))).join(",");
}

function addUniqueVoicing(out: Voicing[], seen: Set<string>, v: Voicing) {
  const key = voicingKey(v);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(v);
}

export function generatedVoicingCandidates(name: string, tuning: TuningSpec, limit = 8): Voicing[] {
  const pcs = chordPitchClasses(name);
  if (pcs.length < 2) return [];
  const tones = [...new Set(pcs)];
  // per-string options: for each chord tone, the lowest fret (0..MAX_FRET)
  // on that string that sounds it; plus the "mute" option (null).
  const options: Voicing[] = tuning.openPc.map((open) => {
    const opts: Voicing = [];
    for (const t of tones) {
      const fret = (((t - open) % 12) + 12) % 12;
      if (fret <= MAX_FRET) opts.push(fret);
    }
    opts.push(null); // allow muting this string
    return opts;
  });

  const candidates: { v: Voicing; score: number }[] = [];
  const pick: Voicing = [null, null, null, null];
  const dfs = (s: number) => {
    if (s === 4) {
      const sounded = pick.filter((f): f is number => f !== null);
      if (!sounded.length) return;
      const covered = new Set(
        pick.map((f, i) => (f === null ? -1 : (tuning.openPc[i] + f) % 12)).filter((x) => x >= 0)
      );
      for (const t of tones) if (!covered.has(t)) return; // require full coverage
      // prefer: more strings sounding, then lower fret span, then lower frets
      const fretted = sounded.filter((f) => f > 0);
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
      const score =
        sounded.length * 100 - span * 8 - (fretted.reduce((a, b) => a + b, 0) / Math.max(1, fretted.length));
      candidates.push({ v: pick.slice(), score });
      return;
    }
    for (const o of options[s]) {
      pick[s] = o;
      dfs(s + 1);
    }
    pick[s] = null;
  };
  dfs(0);
  candidates.sort((a, b) => b.score - a.score);
  const out: Voicing[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    addUniqueVoicing(out, seen, c.v);
    if (out.length >= limit) break;
  }
  return out;
}

// Voicings are pure given the normalized chord name and the tuning, but the
// render loop asks for them every frame (via chordShapeState ->
// setShapeControls). Cache the result so the DFS voicing search runs once per
// chord name, not per frame. Keyed by tuning too, since the same name yields
// entirely different shapes on a baritone.
const voicingCache = new Map<string, Voicing[]>();

export function voicingsForChord(name: string, tuning: TuningSpec): Voicing[] {
  const norm = normalizeChord(name);
  if (!norm) return [];
  const key = `${tuning.id}:${norm}`;
  const cached = voicingCache.get(key);
  if (cached) return cached;
  const out: Voicing[] = [];
  const seen = new Set<string>();
  const verified = verifiedVoicings(tuning)[norm];
  if (verified) addUniqueVoicing(out, seen, verified);
  for (const v of generatedVoicingCandidates(norm, tuning, 10)) addUniqueVoicing(out, seen, v);
  voicingCache.set(key, out);
  return out;
}

const shapeChoice = new Map<string, number>();

export function chordShapeState(name: string, tuning: TuningSpec): {
  norm: string;
  voicing: Voicing | null;
  index: number;
  count: number;
} {
  const norm = normalizeChord(name);
  const variants = voicingsForChord(norm, tuning);
  if (!norm || !variants.length) return { norm, voicing: null, index: 0, count: 0 };
  const raw = shapeChoice.get(norm) ?? 0;
  const index = positiveMod(raw, variants.length);
  if (index !== raw) shapeChoice.set(norm, index);
  return { norm, voicing: variants[index], index, count: variants.length };
}

export function shapeLabel(state: { index: number; count: number }): string {
  return state.count > 0 ? `${state.index + 1}/${state.count}` : "0/0";
}

/// Move the chosen shape for a chord by `delta`, wrapping. Returns false when
/// the chord has no alternative shapes, so callers can skip the redraw.
export function cycleShapeChoice(name: string, tuning: TuningSpec, delta: number): boolean {
  const norm = normalizeChord(name);
  const variants = voicingsForChord(norm, tuning);
  if (!norm || variants.length <= 1) return false;
  shapeChoice.set(norm, positiveMod((shapeChoice.get(norm) ?? 0) + delta, variants.length));
  return true;
}

/// Drop the voicing cache and every cycled shape index. Called when the tuning
/// changes: voicings and the chosen shape index are per-tuning, so a G shape on
/// a baritone is a different list and a stale index would point at nothing.
export function resetVoicingsForTuningChange() {
  voicingCache.clear();
  shapeChoice.clear();
}
