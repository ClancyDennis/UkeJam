// Checks the tab parser in song.ts: which tokens become chords, and which do not.
//
// This exists because of a bug that reached the device. A chart with `[Gx]` in it
// (a typo, or a repeat marker fused to a chord) put "Gx" into chordSequence. The
// app showed it as the target; neither the frontend resolver nor the Rust parser
// could read it, so the detector was left holding NO target; with no target the
// missing/extra diff is empty; and an empty diff is indistinguishable from a
// flawless chord. Result: a freshly loaded song sat there claiming "Locked in"
// with the mic idle, and every bar scored a HIT on silence.
//
// The lesson the tests pin: a token that isn't a chord must never enter
// chordSequence, because everything downstream treats its own inability to parse
// as "nothing to check" rather than "don't score this".
//
// Run with `pnpm verify:songparse`. Plain node, no dependencies — it imports
// song.ts directly so it tests the real parser.

import { parseSong } from "./song.ts";

let failures = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) console.log(`       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

// --- inline [chords]: the path the Gx bug came in through -------------------
{
  const s = parseSong("[G]Another turning [C]point, a [D]fork stuck in the road");
  eq("inline chords are collected in order", s.chordSequence, ["G", "C", "D"]);
}
{
  const s = parseSong("[Gx]Another [G]turning point");
  eq("a bracketed non-chord is dropped, not taken as a target", s.chordSequence, ["G"]);
}
{
  // The regression in full: the exact shape of chart that produced the screenshot.
  const s = parseSong("[Gx] - [Gx] - [G] [G] [C] [D]");
  eq("junk tokens never reach chordSequence", s.chordSequence, ["G", "G", "C", "D"]);
}
{
  const s = parseSong("[Riff]riff here [N.C.]no chord [2x]twice [G]then G");
  eq("annotations in brackets are not chords", s.chordSequence, ["G"]);
}
{
  // Dropping a chord must not shift the remaining chords' lyric anchors.
  const s = parseSong("[Gx]Some [G]words here");
  eq("a dropped chord leaves the surviving anchors correct", s.lines[0].chords, ["G"]);
  eq("...and its position still points at its own syllable", s.lines[0].chordPos, [5]);
  eq("...and the lyric is unharmed", s.lines[0].lyric, "Some words here");
}
{
  // A `|` before a dropped token still opens its bar. Losing it would shift every
  // later bar in the line by one, which silently re-times the whole chart.
  const s = parseSong("| [Gx] [G] | [C] |");
  eq("a bar marker survives the chord after it being dropped", s.chordSequence, ["G", "C"]);
  eq("...and both bar starts are still marked", s.lines[0].barStart, [true, true]);
}
{
  // The chords-above path can't hit that case: isChordOnlyLine gates it, so one
  // junk token means the line isn't treated as a chord line at all. Pin it, since
  // the alternative (silently parsing half of it) is the worse failure.
  const s = parseSong("| Gx G | C |\nsome words");
  eq("a chord-above line containing junk yields no chords", s.chordSequence, []);
  eq("...and is kept as a lyric rather than half-parsed", s.lines[0].lyric, "| Gx G | C |");
}

// --- qualities the old token regex wrongly rejected -------------------------
{
  // CHORD_TOKEN used to alternate on bare "m"/"maj" first, so "m7b5" matched "m"
  // and left "7b5" unconsumed -> the whole token was rejected as a non-chord.
  const s = parseSong("[Am7b5]a [Cmaj7]b [C6]c [Am6]d [Cdim7]e [G7sus4]f [Cadd9]g [D/F#]h");
  eq(
    "extended qualities and slash basses survive",
    s.chordSequence,
    ["Am7b5", "Cmaj7", "C6", "Am6", "Cdim7", "G7sus4", "Cadd9", "D/F#"]
  );
}

// --- chords-above-lyrics ----------------------------------------------------
{
  const s = parseSong("G       C\nAnother turning point");
  eq("chords above a lyric line are collected", s.chordSequence, ["G", "C"]);
}
{
  const s = parseSong("| G | C D |\nAnother turning point");
  eq("bar markers are not chords", s.chordSequence, ["G", "C", "D"]);
  eq("...and they mark bar starts", s.lines[0].barStart, [true, true, false]);
}
{
  // A line of pure annotation is not a chord line, so it must not be consumed
  // as one (which would also swallow the following lyric).
  const s = parseSong("x4 Riff\nAnother turning point");
  eq("an annotation-only line yields no chords", s.chordSequence, []);
}

// --- section headers vs chords in brackets ---------------------------------
{
  const s = parseSong("[Verse 1]\n[G]words");
  eq("a section header is not a chord", s.chordSequence, ["G"]);
  eq("...and it labels the section", s.lines[0].section, "Verse 1");
}
{
  // A bracketed real chord alone on a line is a chord, not a section label.
  const s = parseSong("[G]\n");
  eq("a lone bracketed chord stays a chord", s.chordSequence, ["G"]);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall song-parse checks passed");
