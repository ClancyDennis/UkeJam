// Checks the beat grid in time.ts: where each chord sits, how long the song is,
// and which bar a beat falls in.
//
// This is the arithmetic every scored bar depends on. barOfBeat decides which
// bar a strum is filed under, and chordBeat decides which chord that bar is
// graded against — so an off-by-one here doesn't crash anything, it just marks
// the player wrong for chords they played correctly. Nothing on screen would
// reveal it.
//
// The cases below are the ones the app actually hits: MIDI imports (real tempo
// + bar markers, often several chords per bar), pasted tabs with a {tempo:} but
// no bar markers, and untimed sheets that must NOT get a grid at all.
//
// Run with `pnpm verify:timing`. Plain node, no dependencies.

import { barOfBeat, beatsPerBarOf, buildBeatTimeline, fmtTime, isTimedSong } from "./time.ts";

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

/// Minimal Song shape — only the fields the beat grid reads.
function song({ chords, barStart = [], tempo = 120, timeSig = [4, 4] }) {
  return {
    title: "",
    artist: "",
    lines: [],
    chordSequence: chords,
    barStart: barStart.length ? barStart : chords.map(() => false),
    uniqueChords: [...new Set(chords)],
    tempo,
    timeSig,
  };
}

// --- fmtTime ---
section("fmtTime()");
ok("zero", fmtTime(0) === "0:00", fmtTime(0));
ok("pads seconds", fmtTime(5) === "0:05", fmtTime(5));
ok("a whole minute", fmtTime(60) === "1:00", fmtTime(60));
ok("minutes and seconds", fmtTime(125) === "2:05", fmtTime(125));
ok("truncates rather than rounds", fmtTime(59.9) === "0:59", fmtTime(59.9));
ok("past ten minutes", fmtTime(605) === "10:05", fmtTime(605));

// --- isTimedSong ---
section("isTimedSong()");
ok("tempo + chords is timed", isTimedSong(song({ chords: ["C", "G"] })));
ok("no tempo is untimed", !isTimedSong(song({ chords: ["C"], tempo: 0 })));
ok("tempo but no chords is untimed", !isTimedSong(song({ chords: [] })));

// --- beatsPerBarOf ---
section("beatsPerBarOf()");
ok("4/4 is four beats", beatsPerBarOf(song({ chords: [], timeSig: [4, 4] })) === 4);
ok("3/4 is three beats", beatsPerBarOf(song({ chords: [], timeSig: [3, 4] })) === 3);
ok("6/8 is three quarter-beats", beatsPerBarOf(song({ chords: [], timeSig: [6, 8] })) === 3);
ok("2/2 is four quarter-beats", beatsPerBarOf(song({ chords: [], timeSig: [2, 2] })) === 4);

// --- buildBeatTimeline: no bar markers ---
section("buildBeatTimeline() without bar markers");
{
  const s = song({ chords: ["C", "G", "Am", "F"] });
  const t = buildBeatTimeline(s, 4);
  ok("one beat per chord", t.chordBeat.join(",") === "0,1,2,3", t.chordBeat.join(","));
  ok("length is the chord count", t.songBeats === 4, String(t.songBeats));
}

// --- buildBeatTimeline: one chord per bar ---
section("buildBeatTimeline() with one chord per bar");
{
  const s = song({ chords: ["C", "G", "Am", "F"], barStart: [true, true, true, true] });
  const t = buildBeatTimeline(s, 4);
  ok("each chord lands on a downbeat", t.chordBeat.join(",") === "0,4,8,12", t.chordBeat.join(","));
  ok("length covers the last bar", t.songBeats === 16, String(t.songBeats));
}

// --- buildBeatTimeline: chords sharing a bar ---
section("buildBeatTimeline() with chords sharing a bar");
{
  // |C G |Am | — two chords split bar 1, one chord owns bar 2.
  const s = song({ chords: ["C", "G", "Am"], barStart: [true, false, true] });
  const t = buildBeatTimeline(s, 4);
  ok("a shared bar splits evenly", t.chordBeat.join(",") === "0,2,4", t.chordBeat.join(","));
  ok("the next bar still starts on its downbeat", t.chordBeat[2] === 4);
  ok("length is two bars", t.songBeats === 8, String(t.songBeats));
}
{
  // four chords in one bar
  const s = song({ chords: ["C", "G", "Am", "F"], barStart: [true, false, false, false] });
  const t = buildBeatTimeline(s, 4);
  ok("four chords in a 4/4 bar land one per beat", t.chordBeat.join(",") === "0,1,2,3", t.chordBeat.join(","));
  ok("...and the song is one bar long", t.songBeats === 4, String(t.songBeats));
}
{
  // three chords in a 3/4 bar
  const s = song({ chords: ["C", "G", "Am"], barStart: [true, false, false], timeSig: [3, 4] });
  const t = buildBeatTimeline(s, 3);
  ok("3/4 splits evenly too", t.chordBeat.join(",") === "0,1,2", t.chordBeat.join(","));
}

// --- buildBeatTimeline: the first chord opens a bar even unmarked ---
section("buildBeatTimeline() edge cases");
{
  // barStart[0] false but later markers exist: chord 0 still opens bar 0.
  const s = song({ chords: ["C", "G", "Am"], barStart: [false, true, true] });
  const t = buildBeatTimeline(s, 4);
  ok("chord 0 opens the first bar regardless", t.chordBeat[0] === 0, String(t.chordBeat[0]));
  ok("every chord gets a beat", t.chordBeat.filter((b) => b !== undefined).length === 3,
    JSON.stringify(t.chordBeat));
  ok("beats never go backwards",
    t.chordBeat.every((b, i) => i === 0 || b > t.chordBeat[i - 1]), t.chordBeat.join(","));
}
{
  const t = buildBeatTimeline(song({ chords: [] }), 4);
  ok("an empty song has an empty grid", t.chordBeat.length === 0 && t.songBeats === 0);
}
{
  const s = song({ chords: ["C"], barStart: [true] });
  const t = buildBeatTimeline(s, 4);
  ok("a one-chord song is one bar long", t.songBeats === 4 && t.chordBeat[0] === 0);
}
{
  // A long alternating chart: beats must stay monotonic and bar-aligned.
  const chords = Array.from({ length: 64 }, (_, i) => (i % 2 ? "G" : "C"));
  const barStart = chords.map((_, i) => i % 2 === 0);
  const t = buildBeatTimeline(song({ chords, barStart }), 4);
  ok("64 chords over 32 bars stay monotonic",
    t.chordBeat.every((b, i) => i === 0 || b > t.chordBeat[i - 1]));
  ok("...and end at 32 bars", t.songBeats === 128, String(t.songBeats));
  ok("...with every downbeat on a multiple of 4",
    t.chordBeat.filter((_, i) => i % 2 === 0).every((b) => b % 4 === 0));
}

// --- barOfBeat ---
section("barOfBeat()");
ok("beat 0 is bar 0", barOfBeat(0, 4) === 0);
ok("the last beat of bar 0", barOfBeat(3.99, 4) === 0);
ok("the downbeat of bar 1", barOfBeat(4, 4) === 1);
ok("mid-bar rounds down", barOfBeat(6, 4) === 1);
ok("3/4 bars", barOfBeat(3, 3) === 1);
ok("a split-bar chord is still in its own bar", barOfBeat(2, 4) === 0);
{
  // barOfBeat must agree with the grid buildBeatTimeline laid out: every chord
  // marked as a bar start has to land in a distinct, increasing bar.
  const chords = ["C", "G", "Am", "F", "C", "G"];
  const barStart = [true, false, true, false, true, true];
  const t = buildBeatTimeline(song({ chords, barStart }), 4);
  const bars = t.chordBeat.map((b) => barOfBeat(b, 4));
  ok("the grid and barOfBeat agree on bar boundaries",
    bars.join(",") === "0,0,1,1,2,3", bars.join(","));
}

if (failures) {
  console.error(`\n${failures} timing check(s) failed`);
  process.exit(1);
}
console.log("\nall timing checks passed");
