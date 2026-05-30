"""Robustness over backing audio — the riskiest part of the ukejam vision.

In play-along (speaker) mode the mic hears uke + backing track mixed. This
harness simulates that and tests two things:
  1. How much does a backing track degrade plain chroma chord detection?
  2. Does SPECTRAL SUBTRACTION recover it? (We can subtract because the app
     OWNS the backing track -> we know the reference signal.)

All synthetic, no uke needed. Establishes whether speaker-mode is viable and
how strong the backing can get before detection breaks.
"""

import numpy as np
from chords import build_templates, compute_chroma, detect_chord, NOTE_NAMES
from feedback import synth_fingering
from fretboard import VOICINGS, midi_to_freq

SR = 44100
WIN = 8192


def backing_track(dur, sr=SR, seed_notes=(48, 52, 55, 60), n_harm=5):
    """A synthetic 'song' bed: a sustained pad chord (C major-ish) + light
    broadband noise, to stand in for drums/other instruments."""
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    pad = np.zeros_like(t)
    for midi in seed_notes:
        f = midi_to_freq(midi)
        pad += sum((1.0 / k) * np.sin(2 * np.pi * f * k * t)
                   for k in range(1, n_harm + 1))
    # deterministic pseudo-noise (no RNG: keeps runs reproducible)
    noise = np.sin(2 * np.pi * 997 * t) * np.sin(2 * np.pi * 53 * t)
    bed = pad / np.max(np.abs(pad)) + 0.15 * noise
    return bed / np.max(np.abs(bed))


def spectral_subtract(mix, reference, sr=SR):
    """Subtract the magnitude spectrum of the known reference from the mix,
    keeping the mix's phase. Classic technique; works because we KNOW the
    backing track the app played."""
    n = len(mix)
    win = np.hanning(n)
    M = np.fft.rfft(mix * win)
    R = np.fft.rfft(reference * win)
    mag = np.abs(M) - np.abs(R)
    mag = np.maximum(mag, 0.0)            # half-wave rectify
    cleaned = mag * np.exp(1j * np.angle(M))
    return np.fft.irfft(cleaned, n=n)


def detect(chunk, labels, templates, priors=None):
    chroma = compute_chroma(chunk, SR)
    return detect_chord(chroma, labels, templates, top=1, priors=priors)[0]


def main():
    labels, templates, priors = build_templates()
    dur = 1.0
    bed = backing_track(dur)

    # Test each chord at several backing levels, with and without subtraction.
    levels = [0.0, 0.25, 0.5, 1.0, 2.0]   # backing amplitude relative to uke
    test_chords = ["G", "C", "D", "Em", "Am"]

    print(f"{'chord':6} {'backing':>8} | {'raw mix':<14} {'subtracted':<14}")
    print("-" * 50)
    raw_ok = sub_ok = total = 0
    for label in test_chords:
        uke = synth_fingering(VOICINGS[label], dur=dur)
        # align lengths
        n = min(len(uke), len(bed))
        for lvl in levels:
            mix = uke[:n] + lvl * bed[:n]
            mix = mix / np.max(np.abs(mix))
            ref = lvl * bed[:n]

            off = 5000
            raw = detect(mix[off:off + WIN], labels, templates, priors)
            cleaned = spectral_subtract(mix[off:off + WIN], ref[off:off + WIN])
            sub = detect(cleaned, labels, templates, priors)

            total += 1
            raw_ok += raw[0] == label
            sub_ok += sub[0] == label
            rflag = "OK" if raw[0] == label else "  "
            sflag = "OK" if sub[0] == label else "  "
            print(f"{label:6} {lvl:8.2f} | {raw[0]:<8}{raw[1]:.2f} {rflag}  "
                  f"{sub[0]:<8}{sub[1]:.2f} {sflag}")
        print()
    print("-" * 50)
    print(f"raw mix:     {raw_ok}/{total} correct")
    print(f"subtracted:  {sub_ok}/{total} correct")


if __name__ == "__main__":
    main()
