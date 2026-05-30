"""Live chord detection from the microphone.

Run while playing your baritone uke (D3 G3 B3 E4):
    python live.py

Press Ctrl-C to stop. It prints the detected chord whenever it changes,
gated on signal energy and smoothed over a short window.
"""

import sys
import numpy as np
import sounddevice as sd
from chords import build_templates, compute_chroma, detect_chord

SR = 44100
BLOCK = 4096            # ~93ms per analysis block
SMOOTH = 4             # average chroma over this many recent blocks
RMS_GATE = 0.01        # ignore blocks quieter than this (silence)
MIN_SCORE = 0.7        # only report matches above this confidence


def main():
    labels, templates, priors = build_templates()
    recent = []
    last_report = None

    print("Listening... play a chord. Ctrl-C to stop.\n")

    def callback(indata, frames, time_info, status):
        nonlocal recent, last_report
        if status:
            print(status, file=sys.stderr)
        mono = indata[:, 0].astype(np.float64)
        rms = np.sqrt(np.mean(mono ** 2))
        if rms < RMS_GATE:
            recent.clear()
            return

        chroma = compute_chroma(mono, SR)
        recent.append(chroma)
        if len(recent) > SMOOTH:
            recent.pop(0)

        avg = np.mean(recent, axis=0)
        avg /= np.linalg.norm(avg) or 1.0
        top = detect_chord(avg, labels, templates, top=3, priors=priors)
        label, score = top[0]
        if score >= MIN_SCORE and label != last_report:
            top3 = "  ".join(f"{l}:{s:.2f}" for l, s in top)
            bar = "#" * int(score * 30)
            print(f"  {label:6} {score:.2f} |{bar:<30}|   ({top3})")
            last_report = label

    with sd.InputStream(channels=1, samplerate=SR, blocksize=BLOCK,
                        callback=callback):
        try:
            while True:
                sd.sleep(200)
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
