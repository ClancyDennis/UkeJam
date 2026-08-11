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
  seal,
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
    ...over,
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall verdict checks passed");
