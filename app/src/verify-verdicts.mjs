// Checks the per-bar scorer in verdict.ts: the grading rule, the MISS-vs-WRONG
// split, timing signs, and the LLM digest format.
//
// This is the module the coach's advice is built on, so a wrong verdict is worse
// than no verdict — it teaches the player that a chord they played correctly was
// wrong, or hands the model facts that contradict what the screen showed.
//
// The grading rule (missing == 0 && extra <= 1) is shared with isCleanHit() in
// main.ts and with scorer.py in the prototype; these tests pin it so a future
// tweak to one has to be a deliberate change to all three.
//
// Run with `pnpm verify:verdicts`. Plain node, no dependencies — it imports
// verdict.ts directly (node runs TypeScript natively) so it tests the real
// grader rather than a transpiled or hand-copied version.

import {
  VerdictBuffer,
  accumulate,
  grade,
  newAccumulator,
  rhythmLabel,
  scoreRhythm,
  seal,
  strokePattern,
  strokesInBar,
  timingLabel,
} from "./verdict.ts";

let failures = 0;

function check(name, cond, detail = "") {
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, `got ${g}, want ${w}`);
}

function reading(over = {}) {
  return {
    active: true,
    detected: "C",
    cleanliness: 0.9,
    missing: [],
    extra: [],
    onset: false,
    ...over,
  };
}

// --- the grading rule ---
console.log("grade()");
eq("all target notes, nothing extra -> HIT", grade([], []), "HIT");
eq("one extra note is tolerated -> HIT", grade([], ["D"]), "HIT");
eq("two extra notes -> WRONG", grade([], ["D", "F"]), "WRONG");
eq("a missing note is never a HIT", grade(["G"], []), "WRONG");
eq("missing beats the extra tolerance", grade(["G"], ["D"]), "WRONG");

// --- accumulation: the bar is graded on its best moment ---
console.log("accumulate()");
{
  const acc = newAccumulator();
  // A messy attack, then the chord settles clean.
  accumulate(acc, reading({ cleanliness: 0.4, missing: ["G"], extra: ["D"] }), 100);
  accumulate(acc, reading({ cleanliness: 0.95, missing: [], extra: [] }), 150);
  accumulate(acc, reading({ cleanliness: 0.5, missing: ["E"], extra: [] }), 200);
  const v = seal(acc, { bar: 1, chordIdx: 0, expected: "C", section: "", barStartAt: null });
  eq("peak frame wins, not the last one", v.status, "HIT");
  eq("cleanliness is the peak", v.cleanliness, 0.95);
  eq("diff comes from the peak frame", [v.missing, v.extra], [[], []]);
}
{
  const acc = newAccumulator();
  // Inactive frames must not mark the bar as sounded.
  accumulate(acc, reading({ active: false }), 100);
  const v = seal(acc, { bar: 2, chordIdx: 1, expected: "C", section: "", barStartAt: 0 });
  eq("silence is a MISS, not a WRONG", v.status, "MISS");
  eq("MISS reports nothing heard", v.detected, "");
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ cleanliness: 0.8, missing: [], extra: ["D", "F"] }), 100);
  const v = seal(acc, { bar: 3, chordIdx: 2, expected: "C", section: "", barStartAt: 0 });
  eq("a played-but-wrong bar is WRONG", v.status, "WRONG");
}
{
  // An onset arriving while the frame is below the gate still stamps the attack:
  // the transient can outrun the level the gate is measured on.
  const acc = newAccumulator();
  accumulate(acc, reading({ active: false, onset: true }), 500);
  accumulate(acc, reading({ cleanliness: 0.9 }), 560);
  eq("first onset is recorded even on an inactive frame", acc.onsetAt, 500);
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 300);
  accumulate(acc, reading({ onset: true }), 400);
  eq("only the FIRST onset of a bar is kept", acc.onsetAt, 300);
}

// --- timing ---
console.log("timing");
{
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1120);
  const v = seal(acc, { bar: 4, chordIdx: 3, expected: "C", section: "", barStartAt: 1000 });
  eq("a strum after the downbeat is positive (late)", v.offsetMs, 120);
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 880);
  const v = seal(acc, { bar: 5, chordIdx: 4, expected: "C", section: "", barStartAt: 1000 });
  eq("a strum before the downbeat is negative (early)", v.offsetMs, -120);
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1120);
  const v = seal(acc, { bar: 6, chordIdx: 5, expected: "C", section: "", barStartAt: null });
  eq("untimed songs claim no timing", v.offsetMs, null);
}
{
  // No attack in the bar (a chord held over from the previous one).
  const acc = newAccumulator();
  accumulate(acc, reading({}), 1120);
  const v = seal(acc, { bar: 7, chordIdx: 6, expected: "C", section: "", barStartAt: 1000 });
  eq("a bar with no attack has no offset", v.offsetMs, null);
}
eq("no offset means no timing claim", timingLabel(null), null);
eq("within tolerance is not worth mentioning", timingLabel(60), null);
eq("past tolerance, late", timingLabel(120), "late");
eq("past tolerance, early", timingLabel(-120), "early");

// --- rhythm ---
// The point of rhythm scoring: it needs only that an attack happened, so unlike
// direction it works on every chord and every tuning.
//
// These tests also pin what must NOT be claimed. Without the song's strumming
// pattern the app cannot know how many strums a bar wants, nor whether a strum was
// early or late (on a half-beat grid those are the same event described two ways).
// Both were reported in a first pass and both were wrong: straight eighths came out
// as "rushing", and sensible half notes were scolded as "8/16 strums".
console.log("scoreRhythm()");
{
  // Four strums, one per beat, dead on.
  const r = scoreRhythm([0, 500, 1000, 1500], 0, 4, 0.5);
  eq("counts every strum", r.strums, 4);
  eq("knows the bar's beats", r.beats, 4);
  eq("all four on the beat", r.onBeat, 4);
  eq("no offsets", r.offsets, [0, 0, 0, 0]);
  eq("in time", rhythmLabel(r), "in time");
}
{
  // Every onset is recorded, not just the first — the whole reason for this change.
  const acc = newAccumulator();
  for (const t of [1000, 1500, 2000, 2500]) {
    accumulate(acc, reading({ onset: true }), t);
  }
  eq("accumulator keeps every onset", acc.onsets, [1000, 1500, 2000, 2500]);
  eq("first onset still recorded separately", acc.onsetAt, 1000);
  const v = seal(acc, {
    bar: 1, chordIdx: 0, expected: "C", section: "",
    barStartAt: 1000, beats: 4, secPerBeat: 0.5,
  });
  eq("sealed bar carries rhythm", v.rhythm.strums, 4);
  eq("and scores it on the beat", v.rhythm.onBeat, 4);
}
{
  // The beginner failure this feature exists for: strumming once where the bar
  // wants four. The chord can still be perfect, so it must not be graded as WRONG.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true, cleanliness: 0.95 }), 1000);
  const v = seal(acc, {
    bar: 1, chordIdx: 0, expected: "C", section: "",
    barStartAt: 1000, beats: 4, secPerBeat: 0.5,
  });
  eq("a clean chord strummed once is still a chord HIT", v.status, "HIT");
  eq("the strum count is recorded", v.rhythm.strums, 1);
  // NOT "1 of 4 beats": the app has no pattern for the song, so one strum in a
  // four-beat bar may be exactly right. Judge alignment, never the count.
  eq("a single on-beat strum is in time, not a shortfall",
     rhythmLabel(v.rhythm), "in time");
}
{
  // Nearest-beat matching, not in-order. Miss the downbeat and the remaining
  // strums must still be judged against the beats they were closest to — in-order
  // assignment would compare strum 1 to beat 0, strum 2 to beat 1 and so on,
  // turning one missed beat into a bar of errors.
  const r = scoreRhythm([500, 1000, 1500], 0, 4, 0.5);
  eq("three strums map to beats 1,2,3", r.offsets, [0, 0, 0]);
  eq("all count as on-beat", r.onBeat, 3);
  eq("three on-beat strums are in time", rhythmLabel(r), "in time");
}
{
  const r = scoreRhythm([120, 620, 1120, 1620], 0, 4, 0.5);
  eq("consistent lateness is measured", r.offsets, [120, 120, 120, 120]);
  eq("none on the grid", r.onBeat, 0);
  // NOT "dragging": on a 250ms grid, 120ms out is equally "late for the beat" and
  // "early for the off-beat". The magnitude is a fact, the direction isn't.
  eq("named for tightness, not direction", rhythmLabel(r), "off the beat");
}
{
  // The grid is HALF beats, because that is where real strumming patterns live.
  // Scored against whole beats, every off-beat here reads as 250ms out and the bar
  // came out "rushing" — four perfectly even eighths called a mistake.
  const r = scoreRhythm([0, 250, 500, 750, 1000, 1250, 1500, 1750], 0, 4, 0.5);
  eq("off-beat strums are on the grid, not 250ms out", r.offsets,
     [0, 0, 0, 0, 0, 0, 0, 0]);
  eq("all eight count as in time", r.onBeat, 8);
}
{
  // A syncopated pattern (D DU UDU) must also sit on the grid.
  const r = scoreRhythm([0, 1000, 1250, 1750], 0, 4, 0.5);
  eq("syncopation lands on the grid", r.offsets, [0, 0, 0, 0]);
  eq("and reads as in time", rhythmLabel(r), "in time");
}
{
  // Genuinely loose time: off both the beats and the off-beats. 100ms of a 250ms
  // grid step is unambiguously late for the position it belongs to. (Exactly 125ms
  // would be equidistant between two grid positions and round to the later one,
  // reported as early — a real ambiguity at that spacing, not a bug.)
  const r = scoreRhythm([100, 600, 1100, 1600], 0, 4, 0.5);
  eq("sub-grid drift is caught", r.offsets, [100, 100, 100, 100]);
  eq("and reported as loose time", rhythmLabel(r), "off the beat");
}
{
  const r = scoreRhythm([-100, 400, 900, 1400], 0, 4, 0.5);
  eq("consistent earliness is negative", r.offsets, [-100, -100, -100, -100]);
  eq("named for tightness, not direction", rhythmLabel(r), "off the beat");
}
{
  // A strum slightly BEFORE the downbeat belongs to beat 0, early — not to a beat
  // in the previous bar, and not a whole beat late.
  const r = scoreRhythm([-40], 0, 4, 0.5);
  eq("just-early strum stays on beat 0", r.offsets, [-40]);
  eq("and counts as on-beat within tolerance", r.onBeat, 1);
}
{
  // Extra strums (a busy strumming hand over a simple bar).
  const r = scoreRhythm([0, 250, 500, 750, 1000, 1250, 1500, 1750], 0, 4, 0.5);
  eq("counts them all", r.strums, 8);
  // Straight eighths are normal playing, not an overshoot.
  eq("on-beat eighths are in time", rhythmLabel(r), "in time");
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ active: false }), 1000);
  const v = seal(acc, {
    bar: 1, chordIdx: 0, expected: "C", section: "",
    barStartAt: 1000, beats: 4, secPerBeat: 0.5,
  });
  eq("a silent bar is a MISS", v.status, "MISS");
  eq("with no strums", v.rhythm.strums, 0);
  eq("named plainly", rhythmLabel(v.rhythm), "no strum");
}
{
  // Untimed songs have no beat grid, so there is nothing to score against.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1000);
  const v = seal(acc, {
    bar: 1, chordIdx: 0, expected: "C", section: "", barStartAt: null,
  });
  eq("untimed songs claim no rhythm", v.rhythm, null);
  eq("and rhythmLabel says nothing", rhythmLabel(null), "");
}
{
  // Wait-for-me passes barStartAt null so the parked gap isn't blamed on the
  // player; that must suppress rhythm too, not just the timing offset.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 5000);
  const v = seal(acc, {
    bar: 1, chordIdx: 0, expected: "C", section: "",
    barStartAt: null, beats: 4, secPerBeat: 0.5,
  });
  eq("wait-mode bars carry no rhythm verdict", v.rhythm, null);
}

// --- the buffer ---
console.log("VerdictBuffer");
function verdict(over = {}) {
  return {
    bar: 1,
    chordIdx: 0,
    expected: "C",
    detected: "C",
    status: "HIT",
    missing: [],
    extra: [],
    cleanliness: 0.9,
    offsetMs: null,
    section: "",
    rhythm: null,
    ...over,
  };
}

/// A rhythm block for digest tests: `strums` attacks in a `beats`-beat bar.
/// `camera` defaults to null — the camera-off case, which is what most bars are.
function rhy(strums, beats, offsets = null, camera = null) {
  const offs = offsets ?? new Array(strums).fill(0);
  return {
    strums,
    beats,
    offsets: offs,
    onBeat: offs.filter((o) => Math.abs(o) < 70).length,
    strokes: camera ? camera.map((s) => s.dir) : null,
    ghosts: camera ? camera.filter((s) => s.ghost).length : null,
  };
}
{
  const buf = new VerdictBuffer(4);
  for (let i = 0; i < 6; i++) buf.push(verdict({ bar: i + 1, chordIdx: i }));
  eq("capacity is enforced", buf.length, 4);
  eq(
    "the oldest verdicts are dropped, not the newest",
    buf.recent(4).map((v) => v.bar),
    [3, 4, 5, 6]
  );
}
{
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0, status: "HIT" }));
  buf.push(verdict({ bar: 2, chordIdx: 1, status: "WRONG" }));
  buf.push(verdict({ bar: 3, chordIdx: 2, status: "MISS" }));
  buf.push(verdict({ bar: 4, chordIdx: 3, status: "HIT" }));
  eq("hitRate counts only HITs", buf.hitRate(4), 0.5);
  eq("hitRate windows to the last n", buf.hitRate(2), 0.5);
  eq("hitCount reports both halves", buf.hitCount(4), { hits: 2, total: 4 });
  eq("an empty buffer has no rate", new VerdictBuffer().hitRate(8), null);
}
{
  // A looping song re-grades the same chord indices; the tint must show the pass
  // the player just heard, not the first one.
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0, status: "WRONG" }));
  buf.push(verdict({ bar: 5, chordIdx: 0, status: "HIT" }));
  eq("forChordIdx returns the most recent pass", buf.forChordIdx(0).status, "HIT");
  eq("ungraded chords have no verdict", buf.forChordIdx(9), undefined);
}

// --- the LLM digest ---
console.log("digest()");
{
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 7, chordIdx: 6, expected: "G", status: "HIT", section: "Chorus" }));
  buf.push(
    verdict({
      bar: 8,
      chordIdx: 7,
      expected: "G",
      detected: "Em",
      status: "WRONG",
      missing: ["G", "B"],
      offsetMs: 120,
      section: "Chorus",
    })
  );
  buf.push(verdict({ bar: 9, chordIdx: 8, expected: "C", detected: "", status: "MISS", section: "Chorus" }));
  const out = buf.digest(8, { tempo: 120, timeSig: [4, 4] });
  eq(
    "digest is header + one section label + one line per bar",
    out.split("\n"),
    [
      "tempo 120, 4/4",
      "section: Chorus",
      "7: expect G, clean -> HIT",
      "8: expect G, heard Em, missing G,B, late 120ms -> WRONG",
      "9: expect C, silent -> MISS",
    ]
  );
  check("no markdown in the digest", !/[*#`|]/.test(out), out);
}
{
  // Rhythm in the digest: the coach can only talk about strum texture if the
  // counts are in front of it. A clean chord strummed once in a four-beat bar is
  // the case that used to be invisible — chord HIT, nothing else said.
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0, expected: "C", rhythm: rhy(1, 4) }));
  buf.push(verdict({ bar: 2, chordIdx: 1, expected: "C", rhythm: rhy(4, 4) }));
  buf.push(
    verdict({
      bar: 3, chordIdx: 2, expected: "F",
      rhythm: rhy(4, 4, [130, 130, 130, 130]),
    })
  );
  const lines = buf.digest(8, { tempo: 120, timeSig: [4, 4] }).split("\n");
  eq(
    "digest carries strum counts and tightness, and claims no direction",
    lines.slice(1),
    [
      "1: expect C, clean, 1 strums in 4 beats, 1 in time -> HIT",
      "2: expect C, clean, 4 strums in 4 beats, 4 in time -> HIT",
      "3: expect F, clean, 4 strums in 4 beats, 0 in time -> HIT",
    ]
  );
  check("digest never claims dragging or rushing",
        !/dragging|rushing/.test(lines.join("\n")), lines.join(" | "));
}
{
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0, section: "Verse" }));
  buf.push(verdict({ bar: 2, chordIdx: 1, section: "Verse" }));
  buf.push(verdict({ bar: 3, chordIdx: 2, section: "Chorus" }));
  const lines = buf.digest(8, { tempo: 90, timeSig: [3, 4] }).split("\n");
  eq(
    "a section label appears only when the section changes",
    lines.filter((l) => l.startsWith("section:")),
    ["section: Verse", "section: Chorus"]
  );
}
{
  // Untimed songs have no downbeat, so the model must be told not to invent
  // timing feedback — the bars carry no offsets to reason from.
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0 }));
  const out = buf.digest(8, { tempo: 0, timeSig: [4, 4] });
  check("untimed digests say so", out.startsWith("untimed"), out);
}
eq("an empty buffer digests to nothing", new VerdictBuffer().digest(8, { tempo: 120, timeSig: [4, 4] }), "");

// --- camera strokes: ghosts and direction -----------------------------------
//
// Two failure modes are guarded here, both of the "absence read as evidence" kind
// that has already bitten this codebase twice (an empty note-diff scoring silence
// as HIT; a source guard scanning a file the code had moved out of):
//
//   1. camera off must be null, never 0. Zero says "your hand didn't move" — a
//      judgement about audio nobody recorded.
//   2. a ghost is only knowable ~340ms after the stroke ends, which is AFTER the
//      bar may have sealed. Strokes are therefore assigned by timestamp, not by
//      arrival, or the ones at the ends of bars vanish and it still looks like it
//      mostly works.

const D = (t, ghost = false) => ({ t, dir: "down", ghost });
const U = (t, ghost = false) => ({ t, dir: "up", ghost });

/// The non-camera half of a seal() context, so each test below states only the
/// camera fields it is actually about.
const ctx = () => ({ bar: 1, chordIdx: 0, expected: "C", section: "" });

{
  // (1) The camera-off case, which is the default for every bar today.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1000);
  const v = seal(acc, { ...ctx(), barStartAt: 1000, beats: 4, secPerBeat: 0.5 });
  eq("camera off -> strokes is null, NOT an empty array", v.rhythm.strokes, null);
  eq("camera off -> ghosts is null, NOT zero", v.rhythm.ghosts, null);
  check(
    "camera off says nothing about the hand in the label",
    !rhythmLabel(v.rhythm).includes("hand"),
    rhythmLabel(v.rhythm)
  );
}
{
  // Camera on but the hand genuinely still: 0 is now a real measurement, and must
  // be distinguishable from null.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1000);
  const v = seal(acc, { ...ctx(), barStartAt: 1000, beats: 4, secPerBeat: 0.5, camera: [] });
  eq("camera on, no strokes -> empty array, not null", v.rhythm.strokes, []);
  eq("camera on, no ghosts -> 0, not null", v.rhythm.ghosts, 0);
}
{
  // (2) The late-arrival case. Bar 1 is [1000, 3000); a ghost at 2900 resolves at
  // ~3240, after the bar sealed, and must still land in bar 1.
  const all = [D(1000), U(1250), D(2900, true), D(3100)];
  eq(
    "a stroke near the end of a bar belongs to THAT bar",
    strokesInBar(all, 1000, 3000).map((s) => s.t),
    [1000, 1250, 2900]
  );
  eq(
    "...and the next bar's stroke does not leak backwards",
    strokesInBar(all, 3000, 5000).map((s) => s.t),
    [3100]
  );
}
{
  // A stroke exactly on a downbeat belongs to the bar STARTING, counted once.
  const all = [D(3000)];
  eq("a boundary stroke is not in the closing bar", strokesInBar(all, 1000, 3000).length, 0);
  eq("...it is in the opening bar", strokesInBar(all, 3000, 5000).length, 1);
}
{
  // Out-of-order arrival is normal: a 160ms direction call can be reported after a
  // 340ms ghost from earlier. The bar's strokes must still read in time order.
  const all = [U(2000), D(1000), D(1500, true)];
  eq(
    "strokes come back in time order regardless of arrival order",
    strokesInBar(all, 1000, 3000).map((s) => s.t),
    [1000, 1500, 2000]
  );
}
{
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1000);
  const camera = [D(1000), U(1250, true), D(1500)];
  const v = seal(acc, { ...ctx(), barStartAt: 1000, beats: 4, secPerBeat: 0.5, camera });
  eq("strokes record direction in order", v.rhythm.strokes, ["down", "up", "down"]);
  eq("ghosts count only the silent sweeps", v.rhythm.ghosts, 1);
  eq("the pattern renders in strumming notation", strokePattern(v.rhythm), "↓↑↓");
  // Ghosts are measured but NOT told to the player: a live session counted 25 against
  // 54 strokes, and their flux showed most were quiet strums the onset detector missed.
  // Praising someone for keeping the hand moving when the app just failed to hear them
  // play is the one inversion a practice tool cannot afford.
  check(
    "a ghost is recorded but never surfaces in the label",
    !rhythmLabel(v.rhythm).includes("hand"),
    rhythmLabel(v.rhythm)
  );
}
{
  // Zero ghosts with the camera on is CORRECT playing for anyone strumming every
  // beat. It must read exactly as it did before the camera existed.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true }), 1000);
  const bare = seal(acc, { ...ctx(), barStartAt: 1000, beats: 4, secPerBeat: 0.5 });
  const seen = seal(acc, {
    ...ctx(),
    barStartAt: 1000,
    beats: 4,
    secPerBeat: 0.5,
    camera: [D(1000)],
  });
  eq("zero ghosts reads the same as no camera", rhythmLabel(seen.rhythm), rhythmLabel(bare.rhythm));
  eq("no strokes -> no pattern text", strokePattern(bare.rhythm), "");
}
{
  // Ghosts must not touch the chord verdict. Rhythm and chord fail independently,
  // and coupling them would make a clean chord look wrong for a hand movement.
  const acc = newAccumulator();
  accumulate(acc, reading({ onset: true, missing: [], extra: [] }), 1000);
  const withGhosts = seal(acc, {
    ...ctx(),
    barStartAt: 1000,
    beats: 4,
    secPerBeat: 0.5,
    camera: [D(1000, true), U(1200, true), D(1400, true)],
  });
  eq("ghosts never change the chord verdict", withGhosts.status, "HIT");
  eq("...and grade() is untouched by them", grade([], []), "HIT");
}
{
  // The digest must distinguish camera-off from hand-still, and survive the
  // existing prompt guards.
  const off = new VerdictBuffer();
  off.push(verdict({ bar: 1, chordIdx: 0, rhythm: rhy(4, 4) }));
  off.push(verdict({ bar: 2, chordIdx: 1, rhythm: rhy(4, 4) }));
  const offOut = off.digest(8, { tempo: 120, timeSig: [4, 4] });
  check("camera off adds no sweep clause", !offOut.includes("sweep"), offOut);

  const on = new VerdictBuffer();
  on.push(verdict({ bar: 1, chordIdx: 0, rhythm: rhy(2, 4, [0, 0], [D(0), U(1, true)]) }));
  on.push(verdict({ bar: 2, chordIdx: 1, rhythm: rhy(2, 4, [0, 0], [D(0), U(1, true)]) }));
  const onOut = on.digest(8, { tempo: 120, timeSig: [4, 4] });
  check("a ghost never reaches the coach digest", !onOut.includes("sweep"), onOut);
  check("...and no hand claim is made either way", !onOut.includes("hand"), onOut);
  check("no markdown survives the new clause", !/[*#`|]/.test(onOut), onOut);
  check("still never claims dragging or rushing", !/dragging|rushing/.test(onOut), onOut);

  const zero = new VerdictBuffer();
  zero.push(verdict({ bar: 1, chordIdx: 0, rhythm: rhy(2, 4, [0, 0], [D(0), U(1)]) }));
  zero.push(verdict({ bar: 2, chordIdx: 1, rhythm: rhy(2, 4, [0, 0], [D(0), U(1)]) }));
  check(
    "camera on with zero ghosts also adds no clause",
    !zero.digest(8, { tempo: 120, timeSig: [4, 4] }).includes("sweep"),
    zero.digest(8, { tempo: 120, timeSig: [4, 4] })
  );
}
{
  // The rolling subtitle: ghosts appear only when observed, and camera-off bars
  // don't dilute the count.
  const buf = new VerdictBuffer();
  buf.push(verdict({ bar: 1, chordIdx: 0, rhythm: rhy(2, 4, [0, 0], [D(0), U(1, true)]) }));
  buf.push(verdict({ bar: 2, chordIdx: 1, rhythm: rhy(2, 4) })); // camera off
  const s = buf.rhythmSummary(16);
  check("the subtitle does not report ghosts yet", !s.includes("ghost"), s);

  const none = new VerdictBuffer();
  none.push(verdict({ bar: 1, chordIdx: 0, rhythm: rhy(2, 4) }));
  none.push(verdict({ bar: 2, chordIdx: 1, rhythm: rhy(2, 4) }));
  check("no camera, no ghost text", !none.rhythmSummary(16).includes("ghost"), none.rhythmSummary(16));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall verdict checks passed");
