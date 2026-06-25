// MIDI import — turns a Standard MIDI File into a timed chord chart.
//
// These band-transcription MIDIs carry exact note timing (ticks/quarter),
// tempo, and time signature — information a pasted text tab can't give us. We
// fold the notes into a bar/half-bar chord timeline, name each playable chord by
// template matching, and emit ChordPro-style text with `| bar |` markers and a
// {tempo:} directive. That text flows straight through the existing
// library/parser/strip/highway pipeline and stays editable.
//
// Dependency-free SMF parser (formats 0 and 1). Drum channel (GM ch10 / index
// 9) is ignored for chord detection.

export interface MidiNote {
  tick: number; // absolute tick of note-on
  endTick: number; // absolute tick where the note stops
  ch: number; // channel 0..15
  note: number; // MIDI note number
  velocity: number;
}

// A playable channel in the MIDI — used to build the backing-track selector.
export interface MidiTrack {
  channel: number; // 0..15
  name: string; // GM instrument name (or "Drums" for ch9)
  noteCount: number;
  isDrums: boolean; // GM channel 10 (index 9)
  isBass: boolean; // GM bass family (programs 32..39)
}

export interface MidiData {
  division: number; // ticks per quarter note
  tempoBpm: number;
  timeSig: [number, number]; // [numerator, denominator]
  notes: MidiNote[];
  maxTick: number;
  trackNames: string[];
  tracks: MidiTrack[]; // per-channel summary for the backing selector
}

interface ActiveNote {
  tick: number;
  velocity: number;
}

// Coarse General MIDI program -> family name (enough for a track picker).
function gmName(prog: number): string {
  if (prog < 8) return "Piano";
  if (prog < 16) return "Chromatic Perc";
  if (prog < 24) return "Organ";
  if (prog < 32) return "Guitar";
  if (prog < 40) return "Bass";
  if (prog < 48) return "Strings";
  if (prog < 56) return "Ensemble";
  if (prog < 64) return "Brass";
  if (prog < 72) return "Reed";
  if (prog < 80) return "Pipe";
  if (prog < 88) return "Synth Lead";
  if (prog < 96) return "Synth Pad";
  return "Synth/FX";
}

function readVlq(d: Uint8Array, i: number): [number, number] {
  let v = 0;
  // a VLQ is at most 4 bytes; bail on EOF rather than reading `undefined`
  for (let n = 0; n < 4; n++) {
    if (i >= d.length) throw new Error("truncated MIDI (VLQ runs past end of file)");
    const b = d[i++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [v, i];
  }
  throw new Error("malformed MIDI (VLQ longer than 4 bytes)");
}

export function parseMidi(d: Uint8Array): MidiData {
  if (d.length < 14 || d[0] !== 0x4d || d[1] !== 0x54 || d[2] !== 0x68 || d[3] !== 0x64) {
    throw new Error("not a MIDI file (missing MThd)");
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const ntrk = view.getUint16(10);
  const division = view.getUint16(12);

  let tempo = 500000; // microseconds per quarter (120bpm default)
  let timeSig: [number, number] = [4, 4];
  const notes: MidiNote[] = [];
  const trackNames: string[] = [];
  // per-channel accumulation for the track selector
  const chNotes = new Array(16).fill(0);
  const chProg = new Array(16).fill(-1);
  const chNamed = new Array<string>(16).fill("");

  let i = 14;
  for (let t = 0; t < ntrk; t++) {
    if (i + 8 > d.length || d[i] !== 0x4d || d[i + 1] !== 0x54) break; // no more MTrk chunks
    const tlen = view.getUint32(i + 4);
    // clamp to EOF so a bogus track length can't drive reads past the buffer
    const end = Math.min(i + 8 + tlen, d.length);
    let j = i + 8;
    let tick = 0;
    let status = 0;
    const active = new Map<string, ActiveNote[]>();
    const noteKey = (ch: number, note: number) => `${ch}:${note}`;
    const closeNote = (ch: number, note: number, endTick: number) => {
      const key = noteKey(ch, note);
      const stack = active.get(key);
      if (!stack?.length) return;
      const started = stack.shift();
      if (!started) return;
      if (!stack.length) active.delete(key);
      if (ch !== 9 && endTick > started.tick) {
        notes.push({ tick: started.tick, endTick, ch, note, velocity: started.velocity });
      }
    };
    while (j < end) {
      let dt: number;
      [dt, j] = readVlq(d, j);
      tick += dt;
      if (j >= end) break;
      let b = d[j];
      if (b & 0x80) {
        status = b;
        j++;
      } else {
        b = status; // running status
      }
      if (b === 0xff) {
        if (j >= end) break;
        const meta = d[j++];
        let ln: number;
        [ln, j] = readVlq(d, j);
        const data = d.subarray(j, Math.min(j + ln, end));
        j += ln;
        if (meta === 0x03 && !trackNames[t]) {
          trackNames[t] = new TextDecoder("latin1").decode(data).trim();
        } else if (meta === 0x51 && ln === 3) {
          tempo = (data[0] << 16) | (data[1] << 8) | data[2];
        } else if (meta === 0x58 && ln >= 2) {
          timeSig = [data[0], 2 ** data[1]];
        }
      } else if (b === 0xf0 || b === 0xf7) {
        let ln: number;
        [ln, j] = readVlq(d, j);
        j += ln;
      } else {
        const hi = b & 0xf0;
        const ch = b & 0x0f;
        if (hi === 0x80 || hi === 0x90 || hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
          if (j + 2 > end) break;
          const p1 = d[j];
          const p2 = d[j + 1];
          j += 2;
          if (hi === 0x90 && p2 > 0) {
            chNotes[ch]++;
            const key = noteKey(ch, p1);
            const stack = active.get(key) ?? [];
            stack.push({ tick, velocity: p2 });
            active.set(key, stack);
            if (!chNamed[ch] && trackNames[t]) chNamed[ch] = trackNames[t];
          } else if (hi === 0x80 || hi === 0x90) {
            closeNote(ch, p1, tick);
          }
        } else if (hi === 0xc0) {
          if (j >= end) break;
          if (chProg[ch] < 0) chProg[ch] = d[j];
          j += 1;
        } else if (hi === 0xd0) {
          j += 1;
        }
      }
    }
    for (const [key, stack] of active) {
      const [chRaw, noteRaw] = key.split(":");
      const ch = Number(chRaw);
      const note = Number(noteRaw);
      for (const started of stack) {
        if (ch !== 9 && tick > started.tick) {
          notes.push({ tick: started.tick, endTick: tick, ch, note, velocity: started.velocity });
        }
      }
    }
    i = end;
  }

  notes.sort((a, b) => a.tick - b.tick);
  const maxTick = notes.reduce((m, n) => Math.max(m, n.endTick), 0);
  const tempoBpm = Math.round(60_000_000 / tempo);

  // build per-channel track summaries (channels that actually sound notes)
  const tracks: MidiTrack[] = [];
  for (let ch = 0; ch < 16; ch++) {
    if (chNotes[ch] === 0) continue;
    const isDrums = ch === 9;
    const prog = chProg[ch];
    const isBass = !isDrums && prog >= 32 && prog < 40;
    const name = isDrums
      ? "Drums"
      : chNamed[ch] || (prog >= 0 ? gmName(prog) : `Channel ${ch + 1}`);
    tracks.push({ channel: ch, name, noteCount: chNotes[ch], isDrums, isBass });
  }

  return { division, tempoBpm, timeSig, notes, maxTick, trackNames, tracks };
}

// ---- chord naming from pitch-class energy ----
const PCS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// quality templates. `prior` biases toward ukulele-friendly chord names when
// the raw MIDI contains passing tones or incomplete voicings.
const TEMPLATES: { suffix: string; pcs: number[]; prior: number }[] = [
  { suffix: "", pcs: [0, 4, 7], prior: 0.35 },
  { suffix: "m", pcs: [0, 3, 7], prior: 0.35 },
  { suffix: "sus4", pcs: [0, 5, 7], prior: 0.12 },
  { suffix: "sus2", pcs: [0, 2, 7], prior: 0.10 },
  { suffix: "7", pcs: [0, 4, 7, 10], prior: 0.02 },
  { suffix: "m7", pcs: [0, 3, 7, 10], prior: 0.02 },
  { suffix: "maj7", pcs: [0, 4, 7, 11], prior: -0.02 },
  { suffix: "5", pcs: [0, 7], prior: -0.25 },
  { suffix: "dim", pcs: [0, 3, 6], prior: -0.18 },
  { suffix: "m7b5", pcs: [0, 3, 6, 10], prior: -0.22 },
];

function nameWeightedChord(weights: number[]): string | null {
  const max = Math.max(...weights);
  if (max <= 0) return null;
  const w = weights.map((x) => x / max);
  const total = w.reduce((a, b) => a + b, 0);
  let best: [number, string] | null = null;
  for (let root = 0; root < 12; root++) {
    for (const tmpl of TEMPLATES) {
      const abs = tmpl.pcs.map((p) => (root + p) % 12);
      const chordWeight = abs.reduce((sum, pc) => sum + w[pc], 0);
      const extraWeight = total - chordWeight;
      const missing = abs.filter((pc) => w[pc] < 0.18).length;
      let score = chordWeight * 2.0 - extraWeight * 0.85 - missing * 0.7 + tmpl.prior;
      score += w[root] * 0.35; // a sounding root is a useful tie-break
      // Avoid naming a seventh unless the seventh is actually sustained.
      if ((tmpl.suffix === "7" || tmpl.suffix === "m7" || tmpl.suffix === "maj7") && w[abs[3]] < 0.35) {
        score -= 0.55;
      }
      const name = PCS[root] + tmpl.suffix;
      if (!best || score > best[0]) {
        best = [score, name];
      }
    }
  }
  return best?.[1] ?? null;
}

// Score each channel by how "chordal" it is: the average number of notes that
// start together (same-ish onset). A strummed/comped rhythm part stacks notes
// (>2); a melody/lead plays one at a time (~1). Higher = better chord source.
// Returns a map channel -> score (only channels that sound notes; drums omitted).
export function channelChordScores(data: MidiData): Map<number, number> {
  const { notes, division, timeSig } = data;
  const slot = Math.max(1, Math.round(division / 4)); // ~1/16-note onset bucket
  const ticksPerBar = division * (timeSig[0] || 4) * (4 / (timeSig[1] || 4));
  // per channel: bucket -> count of notes starting in that bucket
  const perCh = new Map<number, Map<number, number>>();
  const perBar = new Map<number, Map<number, Set<number>>>();
  for (const n of notes) {
    if (n.ch === 9) continue; // drums never define chords
    let buckets = perCh.get(n.ch);
    if (!buckets) {
      buckets = new Map();
      perCh.set(n.ch, buckets);
    }
    const b = Math.floor(n.tick / slot);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);

    let bars = perBar.get(n.ch);
    if (!bars) {
      bars = new Map();
      perBar.set(n.ch, bars);
    }
    const firstBar = Math.floor(n.tick / ticksPerBar);
    const lastBar = Math.floor(Math.max(n.tick, n.endTick - 1) / ticksPerBar);
    for (let bar = firstBar; bar <= lastBar; bar++) {
      let pcs = bars.get(bar);
      if (!pcs) {
        pcs = new Set();
        bars.set(bar, pcs);
      }
      pcs.add(n.note % 12);
    }
  }
  const scores = new Map<number, number>();
  for (const [ch, buckets] of perCh) {
    let total = 0;
    let onsets = 0;
    for (const cnt of buckets.values()) {
      total += cnt;
      onsets++;
    }
    // average simultaneity per onset, weighted slightly by how much it plays
    const onsetScore = onsets ? total / onsets : 0;
    const bars = perBar.get(ch);
    const barScore = bars?.size
      ? [...bars.values()].reduce((sum, pcs) => sum + Math.min(pcs.size, 5), 0) / bars.size
      : 0;
    scores.set(ch, Math.max(onsetScore, barScore));
  }
  return scores;
}

// Suggest which channels to derive chords from. There's no perfect automatic
// answer (the loudest channel is sometimes a riff/lead, not the harmony), so
// this is a sensible DEFAULT the user can override: DROP the clearly monophonic
// channels (lead/melody/bass lines — ≲1.5 notes per onset, which inject
// non-chord tones and yield weird names) and BLEND the remaining harmonic ones.
// Falls back to all channels (null) if nothing is clearly polyphonic.
const CHORDAL_MIN = 1.5;
function isLeadLikeTrack(track: MidiTrack): boolean {
  return /\b(lead|melody|solo|vocal|voice)\b/i.test(track.name);
}

export function suggestChordChannels(data: MidiData): number[] | null {
  const scores = channelChordScores(data);
  if (!scores.size) return null;
  const byChannel = new Map(data.tracks.map((t) => [t.channel, t]));
  const rankedAll = [...scores.entries()]
    .filter(([ch]) => {
      const t = byChannel.get(ch);
      return t && !t.isDrums && !t.isBass;
    })
    .sort((a, b) => b[1] - a[1]);
  const rankedNonLead = rankedAll.filter(([ch]) => {
    const t = byChannel.get(ch);
    return t && !isLeadLikeTrack(t);
  });
  const ranked = rankedNonLead.some(([, s]) => s >= CHORDAL_MIN) ? rankedNonLead : rankedAll;
  const best = ranked[0]?.[1] ?? 0;
  if (best >= CHORDAL_MIN) {
    return ranked
      .filter(([, s]) => s >= CHORDAL_MIN && s >= best * 0.65)
      .map(([ch]) => ch)
      .sort((a, b) => a - b);
  }
  const nonBass = data.tracks
    .filter((t) => !t.isDrums && !t.isBass)
    .map((t) => t.channel)
    .sort((a, b) => a - b);
  return nonBass.length ? nonBass : null;
}

export interface MidiChartOptions {
  title?: string;
  artist?: string;
  barsPerLine?: number; // wrap the | bar | text this many bars per line
  collapseRuns?: boolean; // merge consecutive identical bars into one token
  subdivisionsPerBar?: number; // maximum chord changes to infer inside each bar
  // restrict chord extraction to these MIDI channels (e.g. the rhythm part).
  // undefined/null = blend all channels (minus drums).
  chordChannels?: number[] | null;
}

function chordForWindow(
  notes: MidiNote[],
  start: number,
  end: number,
  useNote: (ch: number) => boolean
): string | null {
  const weights = new Array(12).fill(0);
  for (const n of notes) {
    if (n.tick >= end) break;
    if (!useNote(n.ch) || n.endTick <= start) continue;
    const overlap = Math.min(end, n.endTick) - Math.max(start, n.tick);
    if (overlap <= 0) continue;
    weights[n.note % 12] += overlap * Math.max(1, n.velocity) / 127;
  }
  return nameWeightedChord(weights);
}

// Build a ChordPro-style timed chart string from parsed MIDI.
export function midiToChordChart(data: MidiData, opts: MidiChartOptions = {}): string {
  const { division, notes, maxTick, timeSig, tempoBpm } = data;
  const barsPerLine = opts.barsPerLine ?? 4;
  const beatsPerBar = timeSig[0] || 4;
  const defaultSubdivisions = timeSig[0] === 3 && timeSig[1] === 4 ? 3 : 2;
  const subdivisionsPerBar = opts.subdivisionsPerBar ?? defaultSubdivisions;
  const ticksPerBar = division * beatsPerBar * (4 / (timeSig[1] || 4));
  const ticksPerSegment = ticksPerBar / Math.max(1, subdivisionsPerBar);

  // which channels feed chord detection (drums always excluded)
  const chSet = opts.chordChannels && opts.chordChannels.length
    ? new Set(opts.chordChannels)
    : null;
  const useNote = (ch: number) => ch !== 9 && (!chSet || chSet.has(ch));

  // chord per bar across the whole song
  const NC = "N.C.";
  const measures: string[][] = [];
  for (let start = 0; start <= maxTick; start += ticksPerBar) {
    const measure: string[] = [];
    for (let s = 0; s < subdivisionsPerBar; s++) {
      const segStart = start + s * ticksPerSegment;
      const segEnd = Math.min(start + (s + 1) * ticksPerSegment, start + ticksPerBar);
      const chord = chordForWindow(notes, segStart, segEnd, useNote) ?? NC;
      if (chord !== NC && measure[measure.length - 1] !== chord) {
        measure.push(chord);
      }
    }
    measures.push(measure.length ? measure : [NC]);
  }
  // trim leading/trailing empty (N.C.) bars
  while (measures.length && measures[0].every((c) => c === NC)) measures.shift();
  while (measures.length && measures[measures.length - 1].every((c) => c === NC)) measures.pop();
  // interior empty bars: sustain the previous chord (keeps the | bar | line a
  // valid chord-only line, since "N.C." isn't a parseable chord token)
  for (let i = 1; i < measures.length; i++) {
    if (measures[i].every((c) => c === NC)) measures[i] = [measures[i - 1][measures[i - 1].length - 1]];
  }

  let timeline = measures.map((measure) => measure.join(" "));
  if (opts.collapseRuns) {
    timeline = [];
    for (const c of measures.map((measure) => measure.join(" "))) {
      if (!timeline.length || timeline[timeline.length - 1] !== c) timeline.push(c);
    }
  }

  const head: string[] = [];
  if (opts.title) head.push(`{title: ${opts.title}}`);
  if (opts.artist) head.push(`{artist: ${opts.artist}}`);
  head.push(`{tempo: ${tempoBpm}}`);
  head.push(`{time: ${timeSig[0]}/${timeSig[1]}}`);

  const lines: string[] = [];
  for (let i = 0; i < timeline.length; i += barsPerLine) {
    const slice = timeline.slice(i, i + barsPerLine);
    lines.push("| " + slice.join(" | ") + " |");
  }

  return head.join("\n") + "\n\n" + lines.join("\n") + "\n";
}

// Parse a midiToChordChart() string back into its header directives and the
// per-bar chord list (a bar may contain multiple chord tokens). Used by lyric
// fusion so the bar structure stays under our control, not the LLM's.
export function parseChordChart(chart: string): { header: string[]; bars: string[] } {
  const header: string[] = [];
  const bars: string[] = [];
  for (const line of chart.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("{")) {
      header.push(t);
    } else if (t.startsWith("|")) {
      for (const tok of t.split("|")) {
        const c = tok.trim();
        if (c) bars.push(c);
      }
    }
  }
  return { header, bars };
}

function chordTokensInBar(bar: string): string[] {
  return bar.split(/\s+/).map((c) => c.trim()).filter(Boolean);
}

// Rebuild a timed ChordPro with lyrics injected per bar. `lyricByBar` maps a
// 1-based bar index to the words sung during that bar. The bar COUNT and CHORDS
// are fixed by `bars` (the LLM only supplied words), so timing stays perfectly
// aligned. One bar per line keeps the chord↔lyric mapping unambiguous.
export function buildFusedChordPro(
  header: string[],
  bars: string[],
  lyricByBar: Map<number, string>
): string {
  const lines = [...header, ""];
  bars.forEach((chord, i) => {
    const lyric = (lyricByBar.get(i + 1) || "").trim();
    const chords = chordTokensInBar(chord);
    const inline = chords.map((c) => `[${c}]`).join("");
    lines.push(lyric ? `| ${inline}${lyric} |` : `| ${chords.join(" ")} |`);
  });
  return lines.join("\n") + "\n";
}

// "Foo Fighters — The Pretender [MIDIfind.com].mid" -> {artist, title}
export function titleFromFilename(filename: string): { title: string; artist: string } {
  let base = filename.replace(/\.midi?$/i, "");
  base = base.replace(/\s*\[[^\]]*\]\s*/g, "").trim(); // drop [MIDIfind.com] etc.
  const m = base.split(/\s*[—–-]\s*/); // em/en/hyphen separator
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(" - ").trim() };
  return { artist: "", title: base };
}
