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
  // Rhythm: how the bar was strummed, independent of whether the chord was right.
  // `null` for untimed songs, which have no beat grid to score against.
  rhythm: BarRhythm | null;
}

/// How a bar's strums landed against its beats.
///
/// Deliberately separate from the chord verdict. A player can hold a perfect Am and
/// strum it once when the bar wanted four; that bar is a chord HIT and a rhythm
/// failure, and collapsing the two would hide the thing they most need to hear.
export interface BarRhythm {
  strums: number;   // attacks detected in the bar
  beats: number;    // beats the bar contains
  /// Signed ms from the nearest grid position (half beats — see scoreRhythm) for
  /// each strum, in order: negative early, positive late. Length matches `strums`.
  offsets: number[];
  /// Strums that landed within TIMING_TOLERANCE_MS of a grid position. Named for
  /// what a player would call it; the grid includes off-beats.
  onBeat: number;
  /// Hand strokes the CAMERA saw in this bar, in time order — including ones that
  /// sounded no string. `null` means the camera was off for this bar.
  ///
  /// The null matters more than it looks. An empty array says "your hand never
  /// moved", which is a judgement; null says "we weren't looking". Collapsing
  /// those is the same mistake as reading an empty note-diff as a perfect chord,
  /// which once scored silent bars as HIT.
  strokes: Array<"down" | "up"> | null;
  /// Strokes with no strum under them — the hand swept and missed the strings.
  /// `null` when the camera was off.
  ///
  /// Not a fault. "Keep the hand moving through the silent beats" is how strumming
  /// is taught, and it is the one thing a microphone cannot see at all. Zero ghosts
  /// is also perfectly fine (a player strumming every beat has none), so this is
  /// only ever reported as a positive.
  ghosts: number | null;
}

/// A camera stroke as the scorer needs it: when it happened, which way the hand
/// went, and whether any string sounded under it.
export interface CameraStroke {
  /// Midpoint of the stroke, performance.now() domain. The stroke has a duration
  /// (t0..t1 in strumcam.ts) but a bar needs one instant to be assigned to, and the
  /// midpoint is the least arbitrary choice for a sweep that may straddle a
  /// boundary.
  t: number;
  dir: "down" | "up";
  /// No mic onset near this stroke: the hand swept and missed the strings.
  ghost: boolean;
}

export type CameraStrokes = readonly CameraStroke[];

/// The strokes belonging to one bar: `[barStartAt, barEndAt)`, in time order.
///
/// Half-open on purpose. A stroke exactly on a downbeat belongs to the bar that is
/// starting, not the one that just ended, and a closed interval on both sides would
/// count it twice — inflating the ghost count of every bar in a session by however
/// many strokes happen to land on boundaries.
export function strokesInBar(
  all: CameraStrokes,
  barStartAt: number,
  barEndAt: number
): CameraStroke[] {
  return all
    .filter((s) => s.t >= barStartAt && s.t < barEndAt)
    .slice()
    .sort((a, b) => a.t - b.t);
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
  // Every attack in the bar, not just the first. The first onset answers "were you
  // late into this chord"; the whole list answers "did you strum the rhythm" —
  // which is the more basic skill and works on any chord and any tuning, because it
  // needs only that an attack happened, not which string came first.
  onsets: number[];
}

export function newAccumulator(): BarAccumulator {
  return {
    sounded: false,
    cleanliness: 0,
    detected: "",
    missing: [],
    extra: [],
    onsetAt: null,
    onsets: [],
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
  if (r.onset) {
    if (acc.onsetAt === null) acc.onsetAt = now;
    acc.onsets.push(now);
  }
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
    // Beat grid for rhythm scoring. Omitted (or 0) for untimed songs, which have
    // no grid — the bar still gets a chord verdict, just no rhythm.
    beats?: number;
    secPerBeat?: number;
    /// Camera strokes for THIS bar, already windowed by the caller, or null when
    /// the camera was off for it. Omitting it also means null.
    ///
    /// Passed in rather than accumulated per reading because a ghost is only
    /// knowable ~340ms after the stroke ends — it is defined by an onset failing
    /// to arrive — so the fact lands well after the bar has sealed. The caller
    /// therefore keeps a timestamped buffer and hands over the slice that falls in
    /// this bar's window; anything driven by arrival order would drop the strokes
    /// at the ends of bars and look like it mostly worked.
    camera?: CameraStrokes | null;
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
  // Rhythm needs a downbeat and a grid. Wait-for-me bars pass barStartAt as null
  // (the gap between downbeat and strum is the mode working, not the player), and
  // that correctly suppresses rhythm scoring too.
  const rhythm =
    ctx.barStartAt !== null && ctx.beats && ctx.secPerBeat
      ? scoreRhythm(acc.onsets, ctx.barStartAt, ctx.beats, ctx.secPerBeat, ctx.camera ?? null)
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
    rhythm,
  };
}

/// A strum this far off the downbeat is worth mentioning. Below it, the number
/// is mostly detector latency and window quantization (~186ms FFT windows, so
/// onset time is coarse) rather than the player being early or late.
export const TIMING_TOLERANCE_MS = 70;

/// Score a bar's strums against its rhythmic grid.
///
/// The grid is HALF beats, not beats. Essentially every ukulele strumming pattern
/// places strums on beats and on the "and" between them (D-DU-UDU and friends), so
/// an off-beat strum is a correct target, not an error. Scoring against whole beats
/// only, a bar of straight eighths reports every off-beat as 250ms out — and since
/// rounding pushes them all the same way, four perfectly even eighths came out as
/// "rushing". Off-beats are legitimate; being off the half-beat grid is what
/// actually indicates loose time.
///
/// Each strum matches its NEAREST grid position rather than being assigned in
/// order. Order assignment breaks badly on the common case of a missed first strum:
/// every later strum would then be compared against the wrong position, turning one
/// mistake into a bar full of them. Nearest keeps errors local.
export function scoreRhythm(
  onsets: number[],
  barStartAt: number,
  beats: number,
  secPerBeat: number,
  camera: CameraStrokes | null = null
): BarRhythm {
  const stepMs = (secPerBeat * 1000) / 2; // half-beat grid
  const steps = beats * 2;
  // Signed distance to the nearest grid position. The SIGN is only meaningful
  // within half a step: at 120bpm the grid is every 250ms, so a strum 130ms after a
  // beat is equally describable as 130ms late for that beat or 120ms early for the
  // off-beat. Those are the same event, and nothing distinguishes them without
  // knowing which position the player was aiming at — which needs the song's
  // strumming pattern, and the Song model has none. So the magnitude is the honest
  // signal (how loose the time is) and callers must not read drag-vs-rush from it.
  const offsets = onsets.map((t) => {
    const rel = t - barStartAt;
    const nearest = Math.max(0, Math.min(steps - 1, Math.round(rel / stepMs)));
    return Math.round(rel - nearest * stepMs);
  });
  return {
    strums: onsets.length,
    beats,
    offsets,
    onBeat: offsets.filter((o) => Math.abs(o) < TIMING_TOLERANCE_MS).length,
    // Camera-derived, and null-preserving: no camera means no claim about the
    // hand, not a claim that it was still.
    strokes: camera ? camera.map((s) => s.dir) : null,
    ghosts: camera ? camera.filter((s) => s.ghost).length : null,
  };
}

/// One-line summary of a bar's rhythm, or "" when there is nothing to say.
///
/// Two things are deliberately NOT said here, because the app cannot support either
/// without knowing the song's strumming pattern (the Song model has no pattern
/// field):
///
///   - whether the strum COUNT was right. Half notes, eighths and syncopation are
///     all correct playing; "1 of 4 beats" would be an accusation, not feedback.
///   - whether the player was dragging or rushing. On a half-beat grid a strum
///     130ms after a beat is equally "130ms late for the beat" and "120ms early for
///     the off-beat" — the same event, indistinguishable without a known target.
///     Reporting a direction would be a coin flip presented as a fact.
///
/// What survives is how TIGHT the time was: how far strums sat from the nearest grid
/// position. That holds for any pattern, since every pattern is built on
/// subdivisions of the beat.
export function rhythmLabel(r: BarRhythm | null): string {
  if (!r || !r.beats) return "";
  const timing = !r.strums
    ? "no strum"
    : r.onBeat === r.strums
      ? "in time"
      : r.onBeat === 0
        ? "off the beat"
        : `${r.onBeat}/${r.strums} in time`;
  // Ghosts are NOT reported. They are measured (see BarRhythm.ghosts) but not yet
  // trustworthy enough to tell a player about: a live session counted 25 ghosts
  // against 54 strokes, and the flux numbers showed most were quiet strums the onset
  // detector missed rather than deliberate silent sweeps. Praising a player for
  // "keeping the hand moving" when they were actually strumming and not being heard
  // is worse than saying nothing.
  //
  // The onset gate has since been relaxed (ONSET_RATIO 2.2 -> 1.8 in audio.rs), which
  // should shrink the false ghosts; whether enough is a question for the next
  // measurement, not an assumption to ship.
  return timing;
}

/// The strokes a bar was played with, in strumming notation: "↓↑↓↑".
///
/// Ghosts are included but not marked, because `strokes` carries direction only —
/// the count is in `ghosts`. That is deliberate: the pattern answers "what shape did
/// my hand make", which is the thing worth seeing, and threading a per-stroke ghost
/// flag through would make the notation harder to read for a distinction the ghost
/// count already states.
///
/// "" when the camera was off or saw nothing — never a placeholder, so an empty
/// readout can't be mistaken for "your hand didn't move".
export function strokePattern(r: BarRhythm | null): string {
  if (!r || !r.strokes || !r.strokes.length) return "";
  return r.strokes.map((d) => (d === "down" ? "↓" : "↑")).join("");
}

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

  /// Rolling rhythm read over the last `n` bars, or "" when there is nothing to
  /// say. Prefixed with " · " so it appends to the practice subtitle.
  ///
  /// Reports the count problem in preference to the timing one: a player who
  /// strummed twice where four beats were wanted needs that before they need
  /// milliseconds, and saying both at once reads as noise.
  rhythmSummary(n: number): string {
    const w = this.recent(n).filter((v) => v.rhythm && v.rhythm.beats);
    if (w.length < 2) return "";
    let strums = 0;
    let onBeat = 0;
    for (const v of w) {
      strums += v.rhythm!.strums;
      onBeat += v.rhythm!.onBeat;
    }
    if (!strums) return " · no strums";
    // Only tightness, for the reasons in rhythmLabel: neither the strum count nor
    // the direction of a timing error is knowable without the song's strumming
    // pattern, and reporting either would mean scolding correct playing or guessing.
    // Ghosts deliberately absent — see rhythmLabel. They are still recorded on every
    // BarRhythm and shown raw in the StrumCam lab, so the measurement continues; they
    // just don't reach a player until a session shows they mean what they claim.
    return ` · ${onBeat}/${strums} in time`;
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
  // Rhythm as counts only: strums played, and how many landed on the grid. No
  // drag/rush claim — see rhythmLabel for why that isn't derivable — and the strum
  // count is given as raw information, with the prompt told explicitly that a count
  // below the beat count is not an error.
  if (v.rhythm && v.rhythm.beats) {
    const r = v.rhythm;
    parts.push(`${r.strums} strums in ${r.beats} beats, ${r.onBeat} in time`);
    // Silent hand sweeps are NOT sent to the model. They are measured on every bar
    // and shown raw in the StrumCam lab, but a live session counted 25 of them
    // against 54 strokes, and the flux figures showed most were quiet strums the
    // onset detector missed rather than deliberate sweeps. Feeding that to a coach
    // would have it praising a player for keeping the hand moving when what actually
    // happened is the app failed to hear them play — the exact inversion a practice
    // tool cannot afford. Restore this clause when a session shows the count is real.
  }
  return `${parts.join(", ")} -> ${v.status}`;
}
