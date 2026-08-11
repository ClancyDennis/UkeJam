// Checks the chord theory in theory/chords.ts and the fallback shape generator
// in theory/voicings.ts.
//
// verify-voicings.mjs pins the hand-written tables. This pins everything the
// app derives when a chord ISN'T in those tables — which is most of what a MIDI
// import produces. The generator's whole contract is "only ever show chord
// tones"; nothing in the UI would reveal a violation, it would just draw a
// diagram that teaches the wrong chord.
//
// It also pins the rule that stopped a bug reaching the device: an unrecognised
// chord quality must yield NO pitch classes rather than a guessed major triad.
// Guessing meant "Gx" (a repeat marker fused to a chord) silently became G, and
// everything downstream — chromagram, fretboard, scoring — followed the fiction.
//
// Run with `pnpm verify:theory`. Plain node, no dependencies.
//
// As in verify-voicings.mjs, the pitch-class maths here is a deliberate SECOND
// implementation. Importing chordPitchClasses() to check shapes derived from
// chordPitchClasses() would pass no matter how wrong the interval table was.

import { chordPitchClasses, normalizeChord, pcNameToIndex, positiveMod } from "./theory/chords.ts";
import { generatedVoicingCandidates, voicingsForChord, verifiedVoicings } from "./theory/voicings.ts";
import { TUNINGS } from "./tunings.ts";

let failures = 0;
function ok(label, cond, detail = "") {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${detail ? `  — ${detail}` : ""}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

// --- the oracle ---
const BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const INTERVALS = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  aug: [0, 4, 8],
  m7b5: [0, 3, 6, 10],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  add9: [0, 4, 7, 2],
  "7sus4": [0, 5, 7, 10],
  5: [0, 7],
};
const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const QUALITIES = Object.keys(INTERVALS);

function expectedTones(root, quality) {
  const r = ROOTS.indexOf(root);
  return new Set(INTERVALS[quality].map((x) => (r + x) % 12));
}

// --- normalizeChord ---
section("normalizeChord()");
ok("flat roots become sharps", normalizeChord("Bb") === "A#", normalizeChord("Bb"));
ok("slash bass is dropped", normalizeChord("D/F#") === "D", normalizeChord("D/F#"));
ok("bare maj is the plain triad", normalizeChord("Cmaj") === "C", normalizeChord("Cmaj"));
ok("min becomes m", normalizeChord("Amin") === "Am", normalizeChord("Amin"));
ok("m7-5 becomes m7b5", normalizeChord("Fm7-5") === "F#m7b5".slice(1) || normalizeChord("Fm7-5") === "Fm7b5",
  normalizeChord("Fm7-5"));
ok("half-diminished becomes m7b5", normalizeChord("Bø") === "Bm7b5", normalizeChord("Bø"));
ok("degree sign becomes dim", normalizeChord("A°") === "Adim", normalizeChord("A°"));
ok("plus becomes aug", normalizeChord("C+") === "Caug", normalizeChord("C+"));
ok("empty in, empty out", normalizeChord("") === "");
ok("a non-chord passes through unharmed", normalizeChord("Gx") === "Gx", normalizeChord("Gx"));

// --- chordPitchClasses ---
section("chordPitchClasses()");
{
  let mismatches = [];
  for (const root of ROOTS) {
    for (const q of QUALITIES) {
      const name = root + q;
      const got = new Set(chordPitchClasses(name));
      const want = expectedTones(root, q);
      if (got.size !== want.size || [...want].some((pc) => !got.has(pc))) {
        mismatches.push(`${name}: got [${[...got]}] want [${[...want]}]`);
      }
    }
  }
  ok(`all ${ROOTS.length * QUALITIES.length} root/quality pairs sound the right tones`,
    mismatches.length === 0, mismatches.slice(0, 3).join("; "));
}
ok("an unknown quality yields NO pitch classes", chordPitchClasses("Gx").length === 0,
  `got [${chordPitchClasses("Gx")}]`);
ok("...so does a bare repeat marker", chordPitchClasses("Cx4").length === 0);
ok("...and an empty name", chordPitchClasses("").length === 0);
ok("flat names resolve through normalize", chordPitchClasses("Bb")[0] === 10, `${chordPitchClasses("Bb")}`);
ok("a slash chord grades as its root triad",
  chordPitchClasses("D/F#").join(",") === chordPitchClasses("D").join(","));

// --- pcNameToIndex ---
section("pcNameToIndex()");
ok("plain note", pcNameToIndex("F") === 5);
ok("sharp", pcNameToIndex("F#") === 6);
ok("flat", pcNameToIndex("Bb") === 10);
ok("quality after the note is ignored", pcNameToIndex("Am7") === 9);
ok("garbage is -1", pcNameToIndex("x") === -1);
ok("empty is -1", pcNameToIndex("") === -1);

// --- positiveMod ---
section("positiveMod()");
ok("wraps negatives up", positiveMod(-1, 5) === 4);
ok("leaves positives alone", positiveMod(3, 5) === 3);
ok("wraps at the modulus", positiveMod(5, 5) === 0);

// --- the generator ---
section("generatedVoicingCandidates()");
for (const tuning of [TUNINGS.standard, TUNINGS.baritone]) {
  let generated = 0;
  let emptyFor = [];
  const wrong = [];
  for (const root of ROOTS) {
    for (const q of QUALITIES) {
      const name = root + q;
      const want = expectedTones(root, q);
      const shapes = generatedVoicingCandidates(name, tuning, 10);
      if (!shapes.length) {
        emptyFor.push(name);
        continue;
      }
      for (const v of shapes) {
        generated++;
        const sounded = v
          .map((fret, i) => (fret === null ? null : (tuning.openPc[i] + fret) % 12))
          .filter((pc) => pc !== null);
        const extra = sounded.filter((pc) => !want.has(pc));
        const missing = [...want].filter((pc) => !sounded.includes(pc));
        if (extra.length || missing.length) {
          wrong.push(`${name} [${v.join(",")}]` +
            (missing.length ? ` missing [${missing}]` : "") +
            (extra.length ? ` extra [${extra}]` : ""));
        }
        if (v.every((f) => f === null)) wrong.push(`${name} generated an all-muted shape`);
      }
    }
  }
  ok(`${tuning.spelling}: all ${generated} generated shapes sound exactly their chord tones`,
    wrong.length === 0, wrong.slice(0, 3).join("; "));
  // Not every chord is reachable in the low-fret window; that's expected, but a
  // wholesale collapse would mean the search broke.
  ok(`${tuning.spelling}: the generator covers most of the vocabulary`,
    emptyFor.length < ROOTS.length * QUALITIES.length * 0.25,
    `no shape for ${emptyFor.length}: ${emptyFor.slice(0, 6).join(", ")}`);
}
ok("an unknown quality generates nothing", generatedVoicingCandidates("Gx", TUNINGS.standard).length === 0);
ok("a power chord (2 tones) still generates", generatedVoicingCandidates("C5", TUNINGS.standard).length > 0);
ok("the limit is respected", generatedVoicingCandidates("C", TUNINGS.standard, 3).length <= 3);

// --- voicingsForChord ---
section("voicingsForChord()");
for (const tuning of [TUNINGS.standard, TUNINGS.baritone]) {
  const table = verifiedVoicings(tuning);
  const names = Object.keys(table);
  const misordered = names.filter((n) => {
    const first = voicingsForChord(n, tuning)[0];
    return !first || first.join(",") !== table[n].join(",");
  });
  ok(`${tuning.spelling}: the hand-verified shape is offered first for all ${names.length} table chords`,
    misordered.length === 0, misordered.slice(0, 5).join(", "));
}
ok("shapes are de-duplicated", (() => {
  const vs = voicingsForChord("C", TUNINGS.standard);
  const keys = new Set(vs.map((v) => v.join(",")));
  return keys.size === vs.length;
})());
ok("a chord absent from the table still yields shapes",
  voicingsForChord("F#maj7", TUNINGS.standard).length > 0);
ok("an unparseable name yields none", voicingsForChord("Gx", TUNINGS.standard).length === 0);
ok("the same tuning + name is cached to the same array",
  voicingsForChord("Am", TUNINGS.standard) === voicingsForChord("Am", TUNINGS.standard));
ok("the two tunings do not share a cache entry",
  voicingsForChord("Am", TUNINGS.standard) !== voicingsForChord("Am", TUNINGS.baritone));

if (failures) {
  console.error(`\n${failures} theory check(s) failed`);
  process.exit(1);
}
console.log("\nall theory checks passed");
