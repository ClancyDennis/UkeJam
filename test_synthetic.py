"""Prove the chord detector on synthetic audio before touching a real mic.

Generates each test chord as a sum of plucked-string-like tones (fundamental
+ decaying harmonics) and checks the detector's top guess.
"""

import numpy as np
from chords import build_templates, compute_chroma, detect_chord, NOTE_NAMES

SR = 44100

# Note name -> frequency (Hz). MIDI: A4=69=440Hz.
def note_freq(name, octave):
    pc = NOTE_NAMES.index(name)
    midi = 12 * (octave + 1) + pc
    return 440.0 * 2 ** ((midi - 69) / 12)


def pluck(freq, dur=1.0, sr=SR, n_harmonics=6):
    """A crude plucked-string tone: harmonics with 1/k amplitude + decay."""
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    sig = np.zeros_like(t)
    for k in range(1, n_harmonics + 1):
        sig += (1.0 / k) * np.sin(2 * np.pi * freq * k * t)
    envelope = np.exp(-3.0 * t)  # plucked decay
    return sig * envelope


def make_chord(notes, dur=1.0):
    """notes: list of (name, octave). Returns summed audio."""
    sig = sum(pluck(note_freq(n, o), dur) for n, o in notes)
    return sig / np.max(np.abs(sig))


# Real baritone-uke-ish voicings (tuning D3 G3 B3 E4).
TEST_CHORDS = {
    "G":   [("G", 3), ("B", 3), ("D", 4), ("G", 4)],
    "C":   [("C", 3), ("E", 3), ("G", 3), ("C", 4)],
    "D":   [("D", 3), ("A", 3), ("D", 4), ("F#", 4)],
    "Em":  [("E", 3), ("G", 3), ("B", 3), ("E", 4)],
    "Am":  [("A", 2), ("E", 3), ("A", 3), ("C", 4)],
    "A7":  [("A", 2), ("E", 3), ("G", 3), ("C#", 4)],
    "Dmaj7": [("D", 3), ("A", 3), ("C#", 4), ("F#", 4)],
}


def main():
    labels, templates, priors = build_templates()
    print(f"{'expected':10} {'detected':10} {'score':>6}   top-3")
    print("-" * 60)
    correct = 0
    for expected, notes in TEST_CHORDS.items():
        audio = make_chord(notes)
        # analyze a steady chunk after the attack
        chunk = audio[int(0.1 * SR): int(0.1 * SR) + 8192]
        chroma = compute_chroma(chunk, SR)
        top = detect_chord(chroma, labels, templates, top=3, priors=priors)
        detected, score = top[0]
        ok = detected == expected
        correct += ok
        flag = "OK " if ok else "MISS"
        top3 = ", ".join(f"{l}:{s:.2f}" for l, s in top)
        print(f"{expected:10} {detected:10} {score:6.2f}  {flag} [{top3}]")
    print("-" * 60)
    print(f"{correct}/{len(TEST_CHORDS)} correct")


if __name__ == "__main__":
    main()
