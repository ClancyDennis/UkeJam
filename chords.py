"""Chord detection via chromagram + template matching.

Pure numpy/scipy. No ML, no training data. Designed so the algorithm can be
ported to Rust later for a Tauri app.

Pipeline:  audio -> windowed FFT -> log-frequency chroma (12 pitch classes)
           -> normalize -> cosine-match against chord templates.
"""

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# --- Chord templates -------------------------------------------------------
# Each template is a 12-vector over pitch classes (C..B), 1.0 where the chord
# tone lives. Matching is key-invariant because we rotate the template, so we
# only define each *quality* once at root C and try all 12 rotations.
CHORD_QUALITIES = {
    "maj":  [0, 4, 7],
    "m":    [0, 3, 7],
    "7":    [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "m7":   [0, 3, 7, 10],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
    "dim":  [0, 3, 6],
    "aug":  [0, 4, 8],
    "5":    [0, 7],          # power chord
}


# Slight preference for simpler chords. A 4-note chord (e.g. Dmaj7) can edge
# out its triad (D) on harmonic bleed alone, so extended qualities pay a small
# score penalty — a beginner playing a clean triad should see the triad name.
QUALITY_PRIOR = {
    "maj": 1.00, "m": 1.00,
    "5": 0.90,                 # power chords penalized hard: a beginner rarely
                               # means a bare root+fifth — it's usually a triad
                               # whose third is just quiet (e.g. Am's doubled E)
    "sus2": 0.97, "sus4": 0.97,
    "7": 0.96, "m7": 0.96, "maj7": 0.95,
    "dim": 0.95, "aug": 0.95,
}


def build_templates():
    """Return (labels, matrix[N,12], priors[N]) of unit-normalized templates."""
    labels, rows, priors = [], [], []
    for root in range(12):
        for qual, intervals in CHORD_QUALITIES.items():
            vec = np.zeros(12)
            for iv in intervals:
                vec[(root + iv) % 12] = 1.0
            vec /= np.linalg.norm(vec)
            labels.append(f"{NOTE_NAMES[root]}{'' if qual == 'maj' else qual}")
            rows.append(vec)
            priors.append(QUALITY_PRIOR[qual])
    return labels, np.array(rows), np.array(priors)


def compute_chroma(samples, sr, fmin=65.0, fmax=2000.0):
    """Map a mono audio frame to a 12-bin chroma vector.

    Uses a single FFT, maps each bin to its nearest pitch class weighted by
    magnitude, restricted to [fmin, fmax] to focus on the fundamentals and
    low harmonics where uke energy lives.
    """
    samples = samples - np.mean(samples)
    window = np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(samples * window))
    freqs = np.fft.rfftfreq(len(samples), 1.0 / sr)

    chroma = np.zeros(12)
    mask = (freqs >= fmin) & (freqs <= fmax)
    f = freqs[mask]
    mag = spectrum[mask]
    # MIDI (fractional) of each bin, and its nearest semitone.
    midi = 69 + 12 * np.log2(f / 440.0)
    pc = np.round(midi).astype(int) % 12
    # Suppress spectral-leakage skirts: weight each bin by how close it is to
    # an exact semitone. A bin on-pitch keeps full weight; one halfway between
    # two semitones (a leakage tail, e.g. E bleeding toward F) is nearly zeroed.
    cents = np.abs(midi - np.round(midi))          # 0 = on pitch, 0.5 = between
    weight = np.maximum(0.0, np.cos(np.pi * cents)) ** 2
    wmag = mag * weight
    for k in range(12):
        chroma[k] = wmag[pc == k].sum()
    n = np.linalg.norm(chroma)
    return chroma / n if n > 0 else chroma


def detect_chord(chroma, labels, templates, top=3, priors=None):
    """Return top-N (label, score) by cosine similarity.

    If `priors` is given, scores are multiplied by it so simpler chord
    qualities win near-ties (see QUALITY_PRIOR). The returned score is the
    raw cosine similarity, not the prior-weighted ranking value.
    """
    raw = templates @ chroma
    ranked = raw * priors if priors is not None else raw
    idx = np.argsort(ranked)[::-1][:top]
    return [(labels[i], float(raw[i])) for i in idx]


if __name__ == "__main__":
    labels, templates, priors = build_templates()
    print(f"{len(labels)} chord templates built. Sample: {labels[:6]}")
