"""Baritone ukulele fretboard model.

Tuning (low to high): D3 G3 B3 E4 — same as a guitar's top four strings.
Lets us turn a *fingering* (fret per string) into the actual notes that
sound, so synthetic tests use real voicings and we can model finger errors
(wrong fret, muted string, etc.) physically rather than abstractly.
"""

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Open-string MIDI numbers, string 0 = lowest (D3) .. string 3 = highest (E4).
OPEN_STRINGS = [50, 55, 59, 64]   # D3, G3, B3, E4
STRING_NAMES = ["D", "G", "B", "E"]

# fret = None means the string is muted / not played.
# Baritone uke (DGBE) voicings as fret-per-string [D, G, B, E].
# Each verified to sound the intended chord (see tests).
VOICINGS = {
    "G":     [0, 0, 0, 3],   # D G B G  -> G B D
    "C":     [2, 0, 1, 0],   # E G C E  -> C E G
    "D":     [0, 2, 3, 2],   # D A D F# -> D F# A
    "Em":    [2, 0, 0, 0],   # E G B E
    "Am":    [2, 2, 1, 0],   # E A C E  -> A C E
    "E":     [2, 1, 0, 0],   # E G# B E
    "A":     [2, 2, 2, 0],   # E A C# E -> A C# E
    "Dmaj7": [0, 2, 2, 2],   # D A C# F# -> D F# A C#
}


def midi_to_name(midi):
    return NOTE_NAMES[midi % 12] + str(midi // 12 - 1)


def midi_to_freq(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def fingering_to_midi(frets):
    """frets: list of 4 (fret int or None). Returns sounding MIDI notes."""
    notes = []
    for string, fret in enumerate(frets):
        if fret is None:
            continue
        notes.append(OPEN_STRINGS[string] + fret)
    return notes


def fingering_to_pitch_classes(frets):
    """Set of pitch classes (0-11) that a fingering sounds."""
    return sorted({m % 12 for m in fingering_to_midi(frets)})


def expected_pitch_classes(chord_label):
    """Pitch-class set for a known chord voicing."""
    return fingering_to_pitch_classes(VOICINGS[chord_label])


if __name__ == "__main__":
    for name, frets in VOICINGS.items():
        midi = fingering_to_midi(frets)
        names = [midi_to_name(m) for m in midi]
        pcs = [NOTE_NAMES[p] for p in fingering_to_pitch_classes(frets)]
        print(f"{name:6} frets={frets}  notes={names}  classes={pcs}")
