"""Song model + ChordPro-style parser.

A song is metadata + an ordered list of lines; each line is a sequence of
(chord, lyric-fragment) segments. Chords are stored as *names* only — the
instrument decides the displayed fingering, so one song serves uke or guitar.

Import format is ChordPro-ish: directives in {braces}, inline [Chord] markers.
    {title: Riptide}
    {artist: Vance Joy}
    [Am]I was scared of [G]dentists and the [C]dark
"""

import re
from dataclasses import dataclass, field

CHORD_RE = re.compile(r"\[([^\]]+)\]")
DIRECTIVE_RE = re.compile(r"^\{(\w+)\s*:\s*(.*)\}\s*$")

# Recognized chord token, e.g. G, Am, C#m7, Dmaj7, F#dim, A7sus4
CHORD_TOKEN_RE = re.compile(
    r"^[A-G][#b]?(maj|min|m|sus|dim|aug|add)?\d*(sus|add|dim|aug)?\d*$"
)


@dataclass
class Segment:
    chord: str | None   # chord name sounding from here, or None
    text: str           # lyric fragment under/after the chord


@dataclass
class Line:
    segments: list[Segment] = field(default_factory=list)
    section: str | None = None   # set on section-header lines ([Verse], [Chorus])

    @property
    def chords(self):
        return [s.chord for s in self.segments if s.chord]

    @property
    def lyrics(self):
        return "".join(s.text for s in self.segments)


@dataclass
class Song:
    title: str = "Untitled"
    artist: str = ""
    key: str = ""
    lines: list[Line] = field(default_factory=list)

    @property
    def chord_sequence(self):
        """Flat ordered list of chord names across the whole song."""
        seq = []
        for line in self.lines:
            seq.extend(line.chords)
        return seq

    @property
    def unique_chords(self):
        seen, out = set(), []
        for c in self.chord_sequence:
            if c not in seen:
                seen.add(c)
                out.append(c)
        return out


def parse_chordpro(text):
    """Parse ChordPro-ish text into a Song."""
    song = Song()
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        m = DIRECTIVE_RE.match(line.strip())
        if m:
            key, val = m.group(1).lower(), m.group(2).strip()
            if key in ("title", "t"):
                song.title = val
            elif key in ("artist", "subtitle", "st"):
                song.artist = val
            elif key == "key":
                song.key = val
            elif key in ("comment", "c", "section"):
                song.lines.append(Line(section=val))
            continue
        if not line.strip():
            continue  # skip blank lines (could become section breaks later)
        section = _section_header(line)
        if section is not None:
            song.lines.append(Line(section=section))
            continue
        song.lines.append(_parse_line(line))
    return song


def _section_header(line):
    """If the line is just [Word] and not a real chord, return the label.

    Distinguishes structural markers ([Verse], [Chorus], [Bridge]) from inline
    chord markers ([Am], [G]) so headers don't pollute the chord sequence.
    """
    stripped = line.strip()
    m = re.fullmatch(r"\[([^\]]+)\]", stripped)
    if not m:
        return None
    inner = m.group(1).strip()
    if CHORD_TOKEN_RE.match(inner):
        return None  # it's a lone chord, not a section header
    return inner


def _parse_line(line):
    """Split a lyric line with inline [chords] into Segments."""
    segments = []
    pos = 0
    pending_chord = None
    for m in CHORD_RE.finditer(line):
        text = line[pos:m.start()]
        if text or pending_chord is not None:
            segments.append(Segment(pending_chord, text))
        pending_chord = m.group(1)
        pos = m.end()
    tail = line[pos:]
    segments.append(Segment(pending_chord, tail))
    return Line(segments)


if __name__ == "__main__":
    sample = """{title: Riptide}
{artist: Vance Joy}
{key: Am}
[Am]I was scared of [G]dentists and the [C]dark
[Am]I was scared of [G]pretty girls and [C]starting conversations"""
    song = parse_chordpro(sample)
    print(f"{song.title} — {song.artist}  (key {song.key})")
    print("unique chords:", song.unique_chords)
    print("full sequence:", song.chord_sequence)
    print()
    for line in song.lines:
        print("  chords:", line.chords)
        print("  lyric :", repr(line.lyrics))
