// Per-bar scoring — native port of the Python prototype's scorer.py.
//
// The detector reports what is ringing ~45 times a second, judged in isolation.
// That is the right cadence for "your C string isn't sounding" but it can never
// say "you're late into every F" — nothing remembers the last bar. This module
// is that memory: one graded verdict per bar, kept in a ring buffer.
//
// Two consumers, both reading the same buffer:
//   - the UI, immediately and locally (highway trail, strip tint, hit rate)
//   - the coach, which serializes a window of it for the LLM (see digest())
//
// No DOM and no Tauri imports here, so the grader is unit-testable under plain
// node (see verify-verdicts.mjs).

export type Status = "HIT" | "WRONG" | "MISS";

/// What actually happened during one bar (or, in an untimed song, during one
/// chord). `expected` comes from the chart; everything else from the detector.
export interface BarVerdict {
  bar: number; // 1-based bar ordinal within the song
  chordIdx: number; // index into Song.chordSequence
  expected: string;
  detected: string; // "" when nothing sounded
  status: Status;
  missing: string[]; // target notes never heard
  extra: string[]; // notes heard that aren't in the target
  cleanliness: number; // best cosine match seen in the bar, 0..1
  // Strum time relative to the bar's downbeat, in ms: negative = early,
  // positive = late. `null` when no attack was detected (a MISS, or a chord
  // held over from the previous bar), and always null for untimed songs, which
  // have no downbeat to measure against.
  offsetMs: number | null;
  section: string; // enclosing {comment:} label, "" when the song has none
}

/// The best moment of a bar, accumulated frame by frame. "Best" = highest
/// cleanliness, matching how a player experiences a bar: you get the chord
/// right partway through the strum and it rings from there, so grading the peak
/// is fairer than grading the last frame or an average that the initial attack
/// transient drags down.
export interface BarAccumulator {
  sounded: boolean; // any frame above the silence gate
  cleanliness: number;
  detected: string;
  missing: string[];
  extra: string[];
  onsetAt: number | null; // performance.now() of the first attack in the bar
}

export function newAccumulator(): BarAccumulator {
  return {
    sounded: false,
    cleanliness: 0,
    detected: "",
    missing: [],
    extra: [],
    onsetAt: null,
  };
}

/// Fold one detector reading into the current bar. Only the fields the grader
/// needs are read, so this takes a structural type rather than importing
/// main.ts's ChordReading (which would drag the Tauri imports in with it).
export interface Reading {
  active: boolean;
  detected: string;
  cleanliness: number;
  missing: string[];
  extra: string[];
  onset: boolean;
}

export function accumulate(acc: BarAccumulator, r: Reading, now: number): void {
  if (r.onset && acc.onsetAt === null) acc.onsetAt = now;
  if (!r.active) return;
  acc.sounded = true;
  if (r.cleanliness >= acc.cleanliness) {
    acc.cleanliness = r.cleanliness;
    acc.detected = r.detected;
    acc.missing = r.missing.slice();
    acc.extra = r.extra.slice();
  }
}

/// Grade a bar. Deliberately the same rule as scorer.py and as isCleanHit() in
/// main.ts: judge the pitch-class diff, NOT label equality. A one-note tolerance
/// absorbs harmonic bleed and added-color notes, which is why a real uke scores
/// like a player hears it rather than like a template matcher. Keeping the three
/// in step means the strip, the hero chord, and the coach can never disagree.
export function grade(missing: string[], extra: string[]): Status {
  return missing.length === 0 && extra.length <= 1 ? "HIT" : "WRONG";
}

/// Seal an accumulated bar into a verdict. `barStartAt` is the wall clock
/// (performance.now()) of the bar's downbeat, or null for untimed songs.
export function seal(
  acc: BarAccumulator,
  ctx: {
    bar: number;
    chordIdx: number;
    expected: string;
    section: string;
    barStartAt: number | null;
  }
): BarVerdict {
  // Nothing sounded at all: silence or a muted hand. That is a different
  // failure from playing the wrong chord, and the coach should not conflate
  // "you didn't play" with "you played it wrong".
  const status: Status = acc.sounded ? grade(acc.missing, acc.extra) : "MISS";
  const offsetMs =
    ctx.barStartAt !== null && acc.onsetAt !== null
      ? Math.round(acc.onsetAt - ctx.barStartAt)
      : null;
  return {
    bar: ctx.bar,
    chordIdx: ctx.chordIdx,
    expected: ctx.expected,
    detected: acc.sounded ? acc.detected : "",
    status,
    missing: acc.missing,
    extra: acc.extra,
    cleanliness: acc.cleanliness,
    offsetMs,
    section: ctx.section,
  };
}

/// A strum this far off the downbeat is worth mentioning. Below it, the number
/// is mostly detector latency and window quantization (~186ms FFT windows, so
/// onset time is coarse) rather than the player being early or late.
export const TIMING_TOLERANCE_MS = 70;

export function timingLabel(offsetMs: number | null): "early" | "late" | null {
  if (offsetMs === null || Math.abs(offsetMs) < TIMING_TOLERANCE_MS) return null;
  return offsetMs < 0 ? "early" : "late";
}

/// Rolling history of graded bars. Bounded because a long practice session
/// would otherwise grow without limit, and nothing reads further back than a
/// section anyway.
export class VerdictBuffer {
  private items: BarVerdict[] = [];
  // Plain field rather than a constructor parameter property: node's
  // strip-only TypeScript mode rejects those, and verify-verdicts.mjs imports
  // this file directly so it tests the real grader.
  private readonly capacity: number;

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  push(v: BarVerdict): void {
    this.items.push(v);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  clear(): void {
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }

  /// The last `n` verdicts, oldest first.
  recent(n: number): BarVerdict[] {
    return n >= this.items.length ? this.items.slice() : this.items.slice(-n);
  }

  /// Verdict for a given chord index, if that bar has been graded. Used by the
  /// highway and strip to tint bars the playhead has passed.
  forChordIdx(idx: number): BarVerdict | undefined {
    // Search backwards: a looping song re-grades the same indices, and the most
    // recent pass is the one the player just heard.
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].chordIdx === idx) return this.items[i];
    }
    return undefined;
  }

  /// Fraction of the last `n` bars that were HITs, or null when there isn't
  /// enough history to say anything.
  hitRate(n: number): number | null {
    const w = this.recent(n);
    if (!w.length) return null;
    return w.filter((v) => v.status === "HIT").length / w.length;
  }

  /// `hits/total` over the last `n` bars, for the practice subtitle.
  hitCount(n: number): { hits: number; total: number } {
    const w = this.recent(n);
    return { hits: w.filter((v) => v.status === "HIT").length, total: w.length };
  }

  /// Serialize a window for the LLM. One line per bar, facts only.
  ///
  /// The app owns the structure and the verdicts; the model is asked only for
  /// the cross-bar judgment it can't compute. Giving it pre-graded lines (rather
  /// than raw chroma) is what makes "never restate the facts" enforceable — see
  /// SYSTEM_COACH in enhance.rs, and the same split in SYSTEM_FUSE.
  digest(n: number, meta: { tempo: number; timeSig: [number, number] }): string {
    const w = this.recent(n);
    if (!w.length) return "";
    const lines: string[] = [];
    if (meta.tempo > 0) {
      lines.push(`tempo ${Math.round(meta.tempo)}, ${meta.timeSig[0]}/${meta.timeSig[1]}`);
    } else {
      lines.push("untimed (no tempo — say nothing about timing)");
    }
    let section = "";
    for (const v of w) {
      if (v.section && v.section !== section) {
        section = v.section;
        lines.push(`section: ${section}`);
      }
      lines.push(`${v.bar}: ${describe(v)}`);
    }
    return lines.join("\n");
  }
}

/// One bar as a single factual clause. Kept terse: this is the bulk of the
/// prompt, and it repeats once per bar.
function describe(v: BarVerdict): string {
  if (v.status === "MISS") return `expect ${v.expected}, silent -> MISS`;
  const parts = [`expect ${v.expected}`];
  if (v.status === "HIT") {
    parts.push("clean");
  } else {
    if (v.detected && v.detected !== v.expected) parts.push(`heard ${v.detected}`);
    if (v.missing.length) parts.push(`missing ${v.missing.join(",")}`);
    if (v.extra.length) parts.push(`extra ${v.extra.join(",")}`);
  }
  const timing = timingLabel(v.offsetMs);
  if (timing) parts.push(`${timing} ${Math.abs(v.offsetMs!)}ms`);
  return `${parts.join(", ")} -> ${v.status}`;
}
