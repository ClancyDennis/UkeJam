"""Finger-error feedback: compare what's sounding vs. the target chord.

The core coaching feature. Given a live chroma (or a synthesized fingering)
and a target chord, report:
  - MISSING notes  -> a string is muted / not fretted / not ringing
  - EXTRA notes    -> a wrong fret is ringing (finger on wrong spot)
This drops straight out of the chroma we already compute.
"""

import numpy as np
from chords import NOTE_NAMES, compute_chroma
from fretboard import (OPEN_STRINGS, STRING_NAMES, fingering_to_midi,
                       fingering_to_pitch_classes, expected_pitch_classes,
                       midi_to_freq)

SR = 44100
PRESENCE = 0.18   # chroma bin above this (of normalized) counts as "sounding"


def synth_fingering(frets, dur=1.0, sr=SR, n_harmonics=6):
    """Render a fingering to plucked-string audio (for testing without a uke)."""
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    sig = np.zeros_like(t)
    for midi in fingering_to_midi(frets):
        f = midi_to_freq(midi)
        tone = sum((1.0 / k) * np.sin(2 * np.pi * f * k * t)
                   for k in range(1, n_harmonics + 1))
        sig += tone * np.exp(-3.0 * t)
    peak = np.max(np.abs(sig))
    return sig / peak if peak else sig


def sounding_pitch_classes(chroma, thresh=PRESENCE):
    """Pitch classes whose chroma energy is above threshold."""
    return sorted(int(k) for k in range(12) if chroma[k] >= thresh)


def diff_against_target(chroma, target_pcs):
    """Return (missing, extra) pitch-class lists vs. the target chord."""
    playing = set(sounding_pitch_classes(chroma))
    target = set(target_pcs)
    missing = sorted(target - playing)
    extra = sorted(playing - target)
    return missing, extra


def coach(chroma, target_label, target_pcs):
    missing, extra = diff_against_target(chroma, target_pcs)
    tgt = ", ".join(NOTE_NAMES[p] for p in sorted(target_pcs))
    if not missing and not extra:
        return f"{target_label}: correct  (target {{{tgt}}})"
    parts = []
    if missing:
        parts.append("missing " + ",".join(NOTE_NAMES[p] for p in missing))
    if extra:
        parts.append("extra " + ",".join(NOTE_NAMES[p] for p in extra))
    return f"{target_label}: WRONG -> " + "; ".join(parts) + f"  (target {{{tgt}}})"


if __name__ == "__main__":
    # Scenario: target is G. Try a correct G, then two finger errors.
    from fretboard import VOICINGS

    target = "G"
    target_pcs = expected_pitch_classes(target)

    cases = {
        "correct G":             VOICINGS["G"],            # [0,0,0,3]
        "high string open (no 3rd fret)": [0, 0, 0, 0],    # forgot to fret -> E instead of G
        "wrong fret on G string": [0, 1, 0, 3],            # G#: a buzzed/misplaced finger
        "muted low string":      [None, 0, 0, 3],          # missed the D string
    }
    print(f"TARGET: {target}  classes={[NOTE_NAMES[p] for p in target_pcs]}\n")
    for desc, frets in cases.items():
        audio = synth_fingering(frets)
        chroma = compute_chroma(audio[5000:5000 + 8192], SR)
        print(f"  [{desc}]  frets={frets}")
        print("   ", coach(chroma, target, target_pcs))
        print()
