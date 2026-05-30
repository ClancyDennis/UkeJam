"""Record short chord clips for offline analysis & tuning.

Usage:
    python record.py G       # records 2s, saves clips/G.npy, prints detection
    python record.py C 3     # records 3s

Play the chord for the whole countdown. Saves raw audio so we can re-analyze
and tune the algorithm without re-recording.
"""

import os
import sys
import numpy as np
import sounddevice as sd
from chords import build_templates, compute_chroma, detect_chord

SR = 44100
CLIP_DIR = "clips"


def record(label, dur):
    os.makedirs(CLIP_DIR, exist_ok=True)
    print(f"Get ready to play '{label}'...")
    for n in (3, 2, 1):
        print(f"  {n}...")
        sd.sleep(700)
    print("  PLAY NOW")
    rec = sd.rec(int(dur * SR), samplerate=SR, channels=1)
    sd.wait()
    mono = rec[:, 0].astype(np.float64)
    path = os.path.join(CLIP_DIR, f"{label}.npy")
    np.save(path, mono)
    print(f"  saved {path}  ({len(mono)} samples, "
          f"RMS={np.sqrt(np.mean(mono**2)):.4f}, peak={np.max(np.abs(mono)):.3f})")
    return mono


def analyze(mono, label):
    labels, templates, priors = build_templates()
    # take the loudest 8192-sample window (the sustained strum)
    win = 8192
    best_rms, best_i = 0, 0
    for i in range(0, len(mono) - win, win // 2):
        r = np.sqrt(np.mean(mono[i:i + win] ** 2))
        if r > best_rms:
            best_rms, best_i = r, i
    chunk = mono[best_i:best_i + win]
    chroma = compute_chroma(chunk, SR)
    top = detect_chord(chroma, labels, templates, top=5, priors=priors)
    print(f"\n  expected: {label}")
    print(f"  detected: {top[0][0]}  ({'OK' if top[0][0] == label else 'MISS'})")
    print("  top-5: " + ", ".join(f"{l}:{s:.2f}" for l, s in top))
    from chords import NOTE_NAMES
    print("  chroma: " + "  ".join(
        f"{NOTE_NAMES[k]}:{chroma[k]:.2f}" for k in range(12)))


if __name__ == "__main__":
    label = sys.argv[1] if len(sys.argv) > 1 else "test"
    dur = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
    mono = record(label, dur)
    analyze(mono, label)
