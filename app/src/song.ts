// Song parsing — extracts a chord sequence (with lyrics/sections) from pasted
// tabs. Ports the deterministic logic from the Python prototype (song.py /
// importer.py): handles inline ChordPro [G], chords-above-lyrics columns,
// chord-only lines, and [Section] headers. Single-note tablature staves are
// skipped (we play along to chords, not lead riffs).

export interface SongLine {
  section?: string; // set on a [Verse]/[Chorus] header line
  chords: string[]; // chords in order on this line
  barStart: boolean[]; // barStart[i]: chord i begins a new measure
  chordPos: number[]; // chordPos[i]: char index into `lyric` where chord i sits
  lyric: string; // reconstructed lyric text (may be empty)
}

export interface Song {
  title: string;
  artist: string;
  lines: SongLine[];
  chordSequence: string[]; // flat ordered chords across the whole song
  // barStart[i] === true means chordSequence[i] begins a new measure (from a
  // `|` bar marker in the source). Empty/false when the song has no bar info.
  barStart: boolean[];
  uniqueChords: string[];
  // Timing (from {tempo:}/{time:} directives, e.g. a MIDI import). Present when
  // the source carries real timing — this is what drives the timed highway.
  // 0 / undefined for plain pasted tabs with no timing info.
  tempo: number; // beats per minute (0 if unknown)
  timeSig: [number, number]; // [numerator, denominator], default [4,4]
}

// A token that looks like a chord: root + optional accidental + quality.
const CHORD_TOKEN = /^[A-G][#b]?(maj|min|m|sus|dim|aug|add)?\d*(sus|add|dim|aug)?\d*(\/[A-G][#b]?)?$/;
const CHORD_INLINE = /\[([^\]]+)\]/g;
const DIRECTIVE = /^\{(\w+)\s*:\s*(.*)\}\s*$/;

function isChordToken(t: string): boolean {
  return CHORD_TOKEN.test(t);
}

// A line that is only chord tokens (and optional `|` bar markers), e.g.
// "G C D Em" or "| G | C D |" — an intro/instrumental.
function isChordOnlyLine(line: string): boolean {
  const toks = line.trim().split(/\s+/).filter((t) => t !== "|");
  return toks.length > 0 && toks.every(isChordToken);
}

// A tablature staff line like "e|---4--4--|" — we skip these.
function isTabStaffLine(line: string): boolean {
  return /^[eEADGBb]\s*[|:]/.test(line.trim()) || /^[-x0-9|/\\h pb~()]{6,}$/.test(line.trim());
}

// A standalone [Section] header (bracketed word that isn't a chord).
function sectionHeader(line: string): string | null {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  if (!m) return null;
  return isChordToken(m[1].trim()) ? null : m[1].trim();
}

// Insert chords from a chord-above line; `|` tokens mark bar boundaries.
// The chord's column in the chord line maps to its position in the lyric.
function mergeChordsAbove(chordLine: string, lyric: string): SongLine {
  const chords: string[] = [];
  const barStart: boolean[] = [];
  const chordPos: number[] = [];
  let pendingBar = false;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chordLine)) !== null) {
    if (m[0] === "|") {
      pendingBar = true;
      continue;
    }
    chords.push(m[0]);
    barStart.push(pendingBar);
    chordPos.push(Math.min(m.index, lyric.length));
    pendingBar = false;
  }
  return { chords, barStart, chordPos, lyric: lyric.trimEnd() };
}

// Parse a chord-only line, honoring `|` bar markers.
function parseChordOnly(line: string): SongLine {
  return mergeChordsAbove(line, "");
}

// Parse a lyric line that may contain inline [chords] and `|` bar markers.
function parseInline(line: string): SongLine {
  const chords: string[] = [];
  const barStart: boolean[] = [];
  const chordPos: number[] = [];
  let lyric = "";
  let last = 0;
  CHORD_INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHORD_INLINE.exec(line)) !== null) {
    const between = line.slice(last, m.index);
    const bar = between.includes("|");
    lyric += between.replace(/\|/g, "");
    chordPos.push(lyric.length); // chord sits before the next lyric char
    chords.push(m[1]);
    barStart.push(bar);
    last = m.index + m[0].length;
  }
  lyric += line.slice(last).replace(/\|/g, "");
  return { chords, barStart, chordPos, lyric: lyric.trimEnd() };
}

export function parseSong(text: string): Song {
  let title = "Untitled";
  let artist = "";
  let tempo = 0;
  let timeSig: [number, number] = [4, 4];
  const lines: SongLine[] = [];
  const rawLines = text.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // directives {title: ...}
    const dir = trimmed.match(DIRECTIVE);
    if (dir) {
      const key = dir[1].toLowerCase();
      const val = dir[2].trim();
      if (key === "title" || key === "t") title = val;
      else if (key === "artist" || key === "subtitle" || key === "st") artist = val;
      else if (key === "tempo" || key === "bpm") tempo = parseFloat(val) || 0;
      else if (key === "time") {
        const m = val.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) timeSig = [parseInt(m[1], 10), parseInt(m[2], 10)];
      } else if (key === "comment" || key === "c") lines.push({ section: val, chords: [], barStart: [], chordPos: [], lyric: "" });
      continue;
    }

    if (!trimmed) continue;
    if (isTabStaffLine(line)) continue;

    const section = sectionHeader(line);
    if (section) {
      lines.push({ section, chords: [], barStart: [], chordPos: [], lyric: "" });
      continue;
    }

    // inline ChordPro?
    if (/\[[^\]]+\]/.test(line)) {
      lines.push(parseInline(line));
      continue;
    }

    // chords-above-lyrics: a chord-only line followed by a plain lyric line.
    // Guard against consuming the NEXT line when it is itself structural — a
    // bar/measure line (starts with `|`) or an inline-ChordPro line (has
    // [chords]) is its own line, not this line's lyric. This keeps
    // one-bar-per-line timed charts (e.g. from MIDI lyric fusion) intact.
    if (isChordOnlyLine(line)) {
      const next = rawLines[i + 1];
      const nextIsLyric =
        next !== undefined &&
        next.trim() !== "" &&
        !isChordOnlyLine(next) &&
        !isTabStaffLine(next) &&
        !sectionHeader(next) &&
        !next.trim().startsWith("|") &&
        !/\[[^\]]+\]/.test(next);
      if (nextIsLyric) {
        lines.push(mergeChordsAbove(line, next));
        i++; // consume the lyric line
      } else {
        lines.push(parseChordOnly(line)); // standalone chord/intro line
      }
      continue;
    }

    // plain lyric line with no chords
    lines.push({ chords: [], barStart: [], chordPos: [], lyric: trimmed });
  }

  const chordSequence: string[] = [];
  const barStart: boolean[] = [];
  for (const l of lines) {
    l.chords.forEach((ch, i) => {
      chordSequence.push(ch);
      barStart.push(l.barStart[i] ?? false);
    });
  }
  const uniqueChords = [...new Set(chordSequence)];

  return { title, artist, lines, chordSequence, barStart, uniqueChords, tempo, timeSig };
}
