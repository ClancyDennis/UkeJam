"""Record labelled strums for the direction-detection feasibility study.

Usage:
    python record_strums.py Am down          # 20 downstrokes on Am at 60bpm
    python record_strums.py Am down 30       # 30 of them
    python record_strums.py C up 20 --bpm 80
    python record_strums.py --plan           # what to record and why

Saves raw audio to clips/strums_<chord>_<dir>.npy, mirroring record.py: keeping
the samples means the analysis can be re-run as the algorithm changes without
asking you to play everything again.

WHY THIS EXISTS
---------------
The app can detect *when* you strummed but not which way your hand moved. The
proposed method reads the order the strings sound in: a downstroke sweeps string
4 -> 1, an upstroke 1 -> 4. Combinatorially that works for every shape in the
app's voicing tables (see strum_model.py). What is unproven is the physics — that
a real strum staggers the strings by enough time to measure (~3ms+), consistently
enough to rely on.

So: play deliberately and naturally, at a normal practice tempo. Do NOT
exaggerate the strum to help it. An exaggerated stagger would produce numbers that
look good and mean nothing, and we would then build a detector that fails on real
playing. Honest data that kills the idea is a better outcome than flattering data
that wastes a week.
"""

import argparse
import os
import sys

import numpy as np
import sounddevice as sd

from strum_model import (TUNINGS, divergence_index, load_voicings, midi_to_name,
                         templates)

SR = 44100
CLIP_DIR = "clips"

# One strum per beat. 60bpm is slow enough to play cleanly and fast enough that
# the strum itself is a normal-speed gesture rather than a careful sweep.
DEFAULT_BPM = 60
DEFAULT_COUNT = 20

# Shapes worth recording, and why. The 2-attack ones are the interesting cases:
# their first attack is a unison (string 4 and string 1 on the same pitch), so
# direction is only decidable from the second attack onward.
SUGGESTED = ["C", "G", "Am", "F"]


def click(bpm, beats, lead_in=4):
    """Metronome so every take sits on a known grid, making stagger comparable
    across strums. Returns nothing; blocks for the count-in only."""
    period = 60.0 / bpm
    print(f"  count-in ({lead_in} beats at {bpm}bpm)...")
    for n in range(lead_in, 0, -1):
        print(f"    {n}")
        sd.sleep(int(period * 1000))
    print(f"  PLAY — one strum per beat, {beats} strums")


def record(chord, direction, count, bpm, tuning):
    os.makedirs(CLIP_DIR, exist_ok=True)
    voicings = load_voicings(tuning)
    if chord not in voicings:
        print(f"'{chord}' is not in the {tuning} voicing table.", file=sys.stderr)
        print(f"try one of: {', '.join(sorted(voicings)[:24])} ...", file=sys.stderr)
        return None

    frets = voicings[chord]
    down, up = templates(frets, tuning)
    expected = down if direction == "down" else up
    k = divergence_index(frets, tuning)

    print(f"\n{chord} [{', '.join('x' if f is None else str(f) for f in frets)}]"
          f"  {direction}stroke  ({TUNINGS[tuning]['spelling']})")
    print(f"  expected attack order: {' -> '.join(midi_to_name(m) for m in expected)}")
    print(f"  direction decidable from attack {k}"
          + ("  (first attack is a unison — the hard case)" if k == 2 else ""))
    print("\n  Play naturally at a normal practice volume. Do NOT exaggerate the"
          "\n  strum: a slowed-down sweep would give us numbers that don't hold up"
          "\n  in real playing.")

    # One beat per strum, plus a tail so the last strum's decay is captured.
    dur = (count + 1) * 60.0 / bpm
    click(bpm, count)
    rec = sd.rec(int(dur * SR), samplerate=SR, channels=1)
    sd.wait()
    mono = rec[:, 0].astype(np.float64)

    path = os.path.join(CLIP_DIR, f"strums_{chord}_{direction}.npy")
    np.save(path, mono)
    # Store the take's metadata beside the audio so the analyser doesn't have to
    # infer tempo or intent from a filename.
    np.save(path.replace(".npy", "_meta.npy"),
            np.array({"chord": chord, "direction": direction, "bpm": bpm,
                      "count": count, "tuning": tuning, "sr": SR},
                     dtype=object), allow_pickle=True)

    peak = float(np.max(np.abs(mono)))
    rms = float(np.sqrt(np.mean(mono ** 2)))
    print(f"\n  saved {path}  ({len(mono)} samples, RMS={rms:.4f}, peak={peak:.3f})")
    if peak > 0.98:
        print("  WARNING: clipped. A clipped attack destroys the very timing"
              "\n           information we're measuring — re-record quieter.")
    elif peak < 0.05:
        print("  WARNING: very quiet; attack times will be noisy. Move closer"
              "\n           or raise input gain and re-record.")
    return mono


def print_plan(tuning):
    voicings = load_voicings(tuning)
    print(__doc__.strip())
    print(f"\n\nSUGGESTED TAKES ({TUNINGS[tuning]['spelling']})\n")
    for chord in SUGGESTED:
        if chord not in voicings:
            continue
        frets = voicings[chord]
        k = divergence_index(frets, tuning)
        why = ("first attack is a unison — direction only decidable from the "
               "second" if k == 2 else "first attack alone settles direction")
        print(f"  {chord:4s} {str(frets):16s} {why}")
    print("\nFor each shape, record BOTH directions:\n")
    for chord in SUGGESTED:
        if chord in voicings:
            print(f"  python record_strums.py {chord} down 20")
            print(f"  python record_strums.py {chord} up 20")
    print("\nThen: python analyse_strums.py clips/strums_*.npy")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("chord", nargs="?", help="chord name, e.g. Am")
    ap.add_argument("direction", nargs="?", choices=["down", "up"])
    ap.add_argument("count", nargs="?", type=int, default=DEFAULT_COUNT,
                    help=f"number of strums (default {DEFAULT_COUNT})")
    ap.add_argument("--bpm", type=int, default=DEFAULT_BPM)
    ap.add_argument("--tuning", choices=sorted(TUNINGS), default="standard")
    ap.add_argument("--plan", action="store_true",
                    help="print what to record and why, then exit")
    args = ap.parse_args()

    if args.plan or not args.chord or not args.direction:
        print_plan(args.tuning)
        sys.exit(0)
    record(args.chord, args.direction, args.count, args.bpm, args.tuning)
