// Checks every hand-written chord shape in main.ts against the chord's pitch
// classes: a shape must sound EVERY tone of the chord and NOTHING else.
//
// The tables are hand-maintained (the generator optimises for coverage and low
// frets, not for the shapes players actually learn), and a wrong fret is
// invisible in the UI — it just teaches the wrong chord. This caught 16 bad
// standard-tuning shapes on the first run, so it earns its keep.
//
// Run with `pnpm verify:voicings`. Plain node, no dependencies: it reads the
// tables straight out of main.ts so it can never drift from the real data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "main.ts"), "utf8");

/// Extract a `const <name>: Record<string, Voicing> = {...}` literal from the
/// source by brace matching, then evaluate just that object.
function extractTable(name) {
  const start = src.indexOf(`const ${name}: Record<string, Voicing> = {`);
  if (start < 0) throw new Error(`table ${name} not found in main.ts`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const body = src.slice(open, i + 1).replace(/\/\/[^\n]*/g, "");
  return eval(`(${body})`);
}

// Mirrors chordPitchClasses() in main.ts.
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

function chordPitchClasses(name) {
  const m = name.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) throw new Error(`unparseable chord name "${name}"`);
  let root = BASE[m[1]];
  if (m[2] === "#") root = (root + 1) % 12;
  if (m[2] === "b") root = (root + 11) % 12;
  const iv = INTERVALS[m[3]];
  if (!iv) throw new Error(`unknown quality "${m[3]}" in "${name}"`);
  return iv.map((x) => (root + x) % 12);
}

// Open-string pitch classes per table, matching TUNINGS in main.ts.
const TABLES = [
  { name: "STANDARD_VOICINGS", openPc: [7, 0, 4, 9], spelling: "G C E A" },
  { name: "BARITONE_VOICINGS", openPc: [2, 7, 11, 4], spelling: "D G B E" },
];

let checked = 0;
const problems = [];

for (const { name, openPc, spelling } of TABLES) {
  for (const [chord, voicing] of Object.entries(extractTable(name))) {
    checked++;
    const tones = new Set(chordPitchClasses(chord));
    const sounded = voicing
      .map((fret, i) => (fret === null ? null : (openPc[i] + fret) % 12))
      .filter((pc) => pc !== null);
    const extra = sounded.filter((pc) => !tones.has(pc));
    const missing = [...tones].filter((pc) => !sounded.includes(pc));
    if (extra.length || missing.length) {
      problems.push(
        `${spelling}  ${chord} [${voicing.join(", ")}]` +
          (missing.length ? ` missing pitch classes [${missing}]` : "") +
          (extra.length ? ` sounds non-chord tones [${extra}]` : "")
      );
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} of ${checked} shapes are wrong`);
  process.exit(1);
}
console.log(`${checked} chord shapes verified across ${TABLES.length} tunings`);
