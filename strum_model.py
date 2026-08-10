"""Shared model for the strum-direction harness: voicings, string frequencies,
and the down/up templates direction detection is matched against.

The voicing tables are read straight out of `app/src/main.ts` — the same trick
`app/src/verify-voicings.mjs` uses — rather than being copied here. Those tables
are hand-maintained and already verified (244 shapes, `pnpm verify:voicings`), and
a copy would silently drift from the shapes the app actually teaches. The
prototype's own `fretboard.py` is baritone-only with 8 shapes, so it can't cover
the cases that matter most here: standard-tuning first-position shapes like Am and
F, where string 4 and string 1 land on the *same pitch*.

Why those unison shapes matter
------------------------------
Direction detection does not need to know which string produced a pitch — which
is unanswerable for a unison. It needs the ORDER pitches arrive in, compared
against two templates. A downstroke sweeps string 4 -> 1, an upstroke 1 -> 4, so:

    Am [2,0,0,0]   down:  A4  C4  E4  A4
                   up:    A4  E4  C4  A4
                          ^^  ^^
                        same  diverges here

The bracketing A4 is ambiguous and cancels out; the second event decides it. Every
shape in both tables is decidable this way (verified: zero palindromes), with a
worst case of two events.
"""

import os
import re

# Open-string MIDI per tuning, string 4 (thumb side) first — the order a
# downstroke sweeps. Mirrors TUNINGS in main.ts.
#   standard G4 C4 E4 A4 is RE-ENTRANT: string 4 sounds ABOVE string 3, so a
#   downstroke is NOT a rising pitch sweep. That's fine — we compare against the
#   known template, never assume monotonicity.
TUNINGS = {
    "standard": {
        "open_midi": [67, 60, 64, 69],  # G4 C4 E4 A4
        "table": "STANDARD_VOICINGS",
        "spelling": "G C E A",
    },
    "baritone": {
        "open_midi": [50, 55, 59, 64],  # D3 G3 B3 E4
        "table": "BARITONE_VOICINGS",
        "spelling": "D G B E",
    },
}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

MAIN_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "app", "src", "main.ts")


def midi_to_freq(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def midi_to_name(midi):
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def _extract_table(src, name):
    """Pull a `const NAME: Record<string, Voicing> = {...}` literal out of the
    TypeScript source by brace matching. Same approach as verify-voicings.mjs."""
    marker = f"const {name}: Record<string, Voicing> = {{"
    start = src.index(marker)
    open_brace = src.index("{", start)
    depth = 0
    end = open_brace
    for i in range(open_brace, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    body = re.sub(r"//[^\n]*", "", src[open_brace:end + 1])
    out = {}
    for m in re.finditer(r'"?([A-Ga-z0-9#b/]+)"?\s*:\s*\[([^\]]+)\]', body):
        vals = [v.strip() for v in m.group(2).split(",")]
        frets = [None if v == "null" else int(v) for v in vals]
        if len(frets) == 4:
            out[m.group(1)] = frets
    return out


def load_voicings(tuning="standard"):
    """{chord name: [fret per string, 4 entries, None = muted]} from main.ts."""
    with open(MAIN_TS, encoding="utf-8") as fh:
        src = fh.read()
    return _extract_table(src, TUNINGS[tuning]["table"])


def voicing_midi(frets, tuning="standard"):
    """(string index, sounding MIDI) per sounding string, in downstroke order.

    String index is kept so a caller can report *which* string, but note that a
    unison makes two indices indistinguishable in the audio — see the module
    docstring.
    """
    open_midi = TUNINGS[tuning]["open_midi"]
    return [(i, open_midi[i] + f) for i, f in enumerate(frets) if f is not None]


def templates(frets, tuning="standard"):
    """(down, up) expected MIDI sequences for a voicing.

    Down sweeps string 4 -> 1 (the table's natural order); up is the reverse.
    """
    down = [m for _, m in voicing_midi(frets, tuning)]
    return down, down[::-1]


def divergence_index(frets, tuning="standard"):
    """How many attacks are needed before down and up differ (1-based), or None
    if the sequence is palindromic and direction is genuinely undecidable.

    Both shipped tables return 1 or 2 for every shape; None would mean a voicing
    this method fundamentally cannot classify.
    """
    down, up = templates(frets, tuning)
    for i, (a, b) in enumerate(zip(down, up)):
        if a != b:
            return i + 1
    return None


def trackable_strings(frets, tuning="standard", bin_hz=None, min_bins=2.0):
    """Sounding strings whose pitch can be attributed unambiguously.

    Two filters, both necessary:
      - UNIQUE pitch in this voicing. A unison (two strings, identical pitch)
        carries no ordering information: energy at 440 Hz could be either string.
      - SEPARABLE from every other sounding pitch by `min_bins` FFT bins, when
        `bin_hz` is given. Two pitches inside each other's spectral skirt can't be
        told apart no matter how they're ordered in time.

    Returns [(string index, midi, freq)].
    """
    sounding = voicing_midi(frets, tuning)
    counts = {}
    for _, m in sounding:
        counts[m] = counts.get(m, 0) + 1

    out = []
    for i, m in sounding:
        if counts[m] > 1:
            continue
        f = midi_to_freq(m)
        if bin_hz is not None:
            others = [midi_to_freq(m2) for _, m2 in sounding if m2 != m]
            if any(abs(f - fo) < min_bins * bin_hz for fo in others):
                continue
        out.append((i, m, f))
    return out


def describe(chord, frets, tuning="standard"):
    """One-line human summary of a shape, for harness output."""
    down, up = templates(frets, tuning)
    k = divergence_index(frets, tuning)
    return (
        f"{chord:9s} {str(frets):16s} "
        f"down={' '.join(midi_to_name(m) for m in down):26s} "
        f"diverges@{k if k else 'NEVER'}"
    )


if __name__ == "__main__":
    # Sanity readout: every shape in both tables, and the global claim that no
    # voicing is palindromic (i.e. direction is always decidable).
    for tuning in TUNINGS:
        tab = load_voicings(tuning)
        by_k = {}
        for chord, frets in tab.items():
            k = divergence_index(frets, tuning)
            by_k.setdefault(k, []).append(chord)
        print(f"{tuning} ({TUNINGS[tuning]['spelling']}): {len(tab)} voicings")
        for k in sorted(by_k, key=lambda x: (x is None, x)):
            label = "NEVER (undecidable)" if k is None else f"{k} attack(s)"
            print(f"   diverges after {label}: {len(by_k[k])}")
        print()
