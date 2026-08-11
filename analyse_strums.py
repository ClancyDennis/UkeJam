"""Measure whether strum direction is recoverable from audio.

Usage:
    python analyse_strums.py --synthetic              # self-test, no uke needed
    python analyse_strums.py clips/strums_*.npy       # real takes
    python analyse_strums.py clips/strums_Am_down.npy --verbose

THE QUESTION
------------
A downstroke sweeps string 4 -> 1, an upstroke 1 -> 4. If we can measure the order
the strings sound in, we know the direction. strum_model.py establishes that the
ORDER is decidable for every shape in the app's voicing tables (worst case: two
attacks, because a unison makes the first ambiguous).

What that does not establish is the physics: that a real strum staggers the strings
by enough time to measure, consistently. That is what this script measures, and it
is a genuine gate.

METHOD
------
Per strum, for each *trackable* string (unique pitch in this voicing, and far
enough from its neighbours in frequency to resolve — see
strum_model.trackable_strings), track narrowband energy at that string's frequency
with a Goertzel filter over 1ms hops, and take the attack as the point the envelope
first crosses half its peak. Order those times, compare the resulting sequence
against the down and up templates, and report which fits better and by how much.

Goertzel rather than a full FFT because only a handful of known frequencies matter
per shape: O(N) per frequency instead of O(N log N) for all of them. The real
detector in audio.rs would use a short-hop FFT (it needs many bins at once and
already has a plan), but the timing measurement is equivalent.

WHAT THE SELF-TEST ALREADY ESTABLISHED
--------------------------------------
Running --synthetic on strums with known stagger found the method's resolution
floor, and it is NOT the estimator: a string sounded alone has its crossing located
to better than 0.1ms, with near-identical latency across the frequency range (so
the latency cancels in a difference). The floor comes from strings sounding
TOGETHER — each one's narrowband envelope picks up its neighbours' leakage, shifting
the crossing by an amount that depends on the voicing. Measured at a true 0ms
stagger: C 2.8ms, G 2.6ms, Am 1.9ms, F 0.8ms.

Consequently this method needs roughly 8ms of real stagger to classify confidently,
and reports "unknown" below that rather than guessing. That is a much higher bar
than the ~3ms originally assumed, and it is the number real takes have to beat.

READING THE OUTPUT
------------------
`stagger` is the median gap between consecutive string attacks in one strum; its
spread across takes decides feasibility. `direction accuracy` is how often the
template match got the known answer right. `margin` is how much better the winning
template fit — the basis for the shipped detector's confidence floor, so it can say
"not sure" instead of guessing.
"""

import argparse
import glob
import os
import sys

import numpy as np

from strum_model import (TUNINGS, divergence_index, load_voicings, midi_to_freq,
                         midi_to_name, templates, trackable_strings,
                         voicing_midi)

SR = 44100

# Analysis hop. 1ms is finer than the stagger we're hoping to see (~3ms+), so the
# measurement resolution is not the limiting factor in the result.
HOP_MS = 1.0

# Goertzel block length, and the reason it is not shorter.
#
# The block sets frequency selectivity: bin width is SR/BLOCK. Adjacent strings in
# real voicings can be as close as 62Hz (C's E4 vs G4) or 68Hz (Am's C4 vs E4), so
# a block whose bin width exceeds ~30Hz lets each filter hear its neighbour's
# attack and reports whichever string is louder, not whichever sounded first.
# The first version of this script used 512 (86Hz bins) and misclassified
# direction on exactly those shapes.
#
# 2048 gives 21.5Hz bins — matching the window the real detector would use — at
# the cost of a ~46ms integration time. That does NOT blur a 3ms stagger away,
# because the attack is found from the *rising edge* of the envelope, and the hop
# is 1ms: a later-starting string's edge still moves later by the stagger. Longer
# integration costs edge sharpness, not edge position.
BLOCK = 2048
# Bin width implied by BLOCK, used to decide which strings are resolvable at all.
BIN_HZ = SR / BLOCK
# Two pitches closer than this many bins can't be attributed to separate strings.
MIN_SEP_BINS = 2.0

# A strum is found where broadband energy jumps. Deliberately loose — we then
# measure precise per-string timing *within* each detected strum, so this only has
# to segment strums from each other, not time them.
STRUM_MIN_GAP_MS = 150.0

# The shipped detector's threshold (ONSET_RATIO in audio.rs), calibrated only
# against synthetic sines. Real audio either supports it or it needs changing.
SHIPPED_ONSET_RATIO = 2.2


def goertzel_envelope(x, freq, sr=SR, block=BLOCK, hop=None):
    """Magnitude at `freq` over sliding blocks. Returns (times_s, magnitudes).

    Goertzel evaluates a single DFT bin in O(N) — ideal here because each shape
    only has a few frequencies of interest.
    """
    hop = hop or max(1, int(sr * HOP_MS / 1000))
    w = 2.0 * np.pi * freq / sr
    coeff = 2.0 * np.cos(w)
    win = np.hanning(block)
    n = 1 + max(0, (len(x) - block) // hop)
    mags = np.empty(n)
    times = np.empty(n)
    for i in range(n):
        seg = x[i * hop:i * hop + block] * win
        s1 = s2 = 0.0
        for v in seg:
            s0 = v + coeff * s1 - s2
            s2, s1 = s1, s0
        mags[i] = np.sqrt(max(0.0, s1 * s1 + s2 * s2 - coeff * s1 * s2))
        times[i] = (i * hop + block / 2) / sr
    return times, mags


def goertzel_envelope_fast(x, freq, sr=SR, block=BLOCK, hop=None):
    """Vectorised equivalent of goertzel_envelope — same maths via complex mixing.

    The scalar recurrence above is the textbook form and easy to check; this is
    what actually runs, since a 20-strum take at a 1ms hop is ~20k blocks per
    string and the Python-level loop would dominate the runtime. Kept side by side
    so the fast path can be verified against the obvious one (see --self-check).
    """
    hop = hop or max(1, int(sr * HOP_MS / 1000))
    if len(x) < block:
        return np.array([]), np.array([])
    n = 1 + (len(x) - block) // hop
    idx = np.arange(block)
    win = np.hanning(block)
    # e^{-jwn} applied to each windowed block, summed -> that block's DFT bin.
    kernel = win * np.exp(-2j * np.pi * freq * idx / sr)
    starts = np.arange(n) * hop
    # Strided view: (n, block) without copying the signal.
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(n, block), strides=(x.strides[0] * hop, x.strides[0]))
    mags = np.abs(frames @ kernel)
    times = (starts + block / 2) / sr
    return times, mags


# A strum must reach this fraction of the take's loudest strum to count. Guards
# against the same failure the live rig hit: without an absolute floor, room noise
# and decay tails are "rises" too.
STRUM_MIN_LEVEL_FRAC = 0.15
# A new attack has to be RISING by this factor over the previous frame. Same test
# as strum_lab's Listener, and for the same reason — see below.
STRUM_RISE_RATIO = 1.30


def find_strums(x, sr=SR, min_gap_ms=STRUM_MIN_GAP_MS):
    """Strum start positions (sample indices) from broadband energy rises.

    An onset is a RISE, not a level, and not a derivative above a global threshold.
    The earlier version compared the energy derivative against a percentile of the
    whole take, which fires repeatedly through a decay: on a real 46-strum session
    it reported 148 strums. A plucked note decays slowly enough that its tail keeps
    clearing any fixed derivative bar, so the extra "strums" were the same notes
    ringing out — and each phantom got measured and scored as if it were a
    performance.

    The live rig hit exactly this and fixed it with a frame-to-frame rise test plus
    an absolute level gate; this is that logic, so the two paths agree about what
    counts as a strum.
    """
    hop = max(1, int(sr * 0.002))  # 2ms
    win = int(sr * 0.010)          # 10ms
    n = 1 + max(0, (len(x) - win) // hop)
    if n <= 2:
        return []
    env = np.array([np.sqrt(np.mean(x[i * hop:i * hop + win] ** 2)) for i in range(n)])
    if not env.max():
        return []

    # Absolute floor, relative to this take's own loudest strum so it works at any
    # recording level.
    floor = env.max() * STRUM_MIN_LEVEL_FRAC
    min_gap = max(1, int(min_gap_ms / 1000 * sr / hop))
    hits = []
    last = -min_gap * 2
    for i in range(1, n):
        rising = env[i] > env[i - 1] * STRUM_RISE_RATIO
        if rising and env[i] >= floor and i - last >= min_gap:
            hits.append(i * hop)
            last = i
    return hits


ATTACK_FRAC = 0.5


def attack_time(times, mags, frac=ATTACK_FRAC):
    """When this string's energy started rising, in seconds — or None.

    Uses the FIRST CROSSING of `frac` of the peak on the rising edge, linearly
    interpolated between hops, rather than the steepest slope. Both mark the same
    edge, but a crossing localises its *position* far more stably: the slope
    maximum wanders with envelope noise and with how the long Goertzel block
    smooths the edge, and wandering is fatal here because the whole measurement is
    a comparison of two edge positions a few milliseconds apart.

    A common fraction across strings is what makes the comparison fair: every
    string's edge is measured at the same relative height, so a loud string and a
    quiet one are not systematically offset. The absolute value is biased late by
    roughly half the block, but that bias is identical for all strings and cancels
    in the difference — which is all direction depends on.

    Returns None when the envelope never rises (a muted or undetected string): the
    peak sits at the very first sample, so there is no edge to find.
    """
    if len(mags) < 3:
        return None
    peak_i = int(np.argmax(mags))
    peak = mags[peak_i]
    if peak <= 0 or peak_i == 0:
        # No rising edge in view — the string was already sounding when the window
        # opened, or it never sounded.
        return None
    target = frac * peak
    rise = mags[:peak_i + 1]
    above = np.nonzero(rise >= target)[0]
    if not len(above):
        return None
    i = int(above[0])
    if i == 0:
        # Already above the threshold in the very first envelope sample, so the
        # rising edge happened at or before the window opened and cannot be
        # located — return None rather than times[0].
        #
        # Reporting times[0] was actively harmful: every such string got the SAME
        # timestamp (BLOCK/2 = 23.2ms), so several unlocatable strings looked
        # perfectly simultaneous, or one locatable string paired against a fake
        # 23.2ms produced a large fabricated gap. In a smoke run against room
        # noise this manufactured confident WRONG directions with margins up to
        # 0.83 — the failure mode most likely to be mistaken for a real result.
        return None
    # Interpolate between the straddling hops for sub-hop resolution.
    m0, m1 = rise[i - 1], rise[i]
    if m1 == m0:
        return float(times[i])
    frac_between = (target - m0) / (m1 - m0)
    return float(times[i - 1] + frac_between * (times[i] - times[i - 1]))


def measure_strum(x, frets, tuning, sr=SR):
    """Per-string attack times for one isolated strum.

    Separability is judged at BIN_HZ — the resolution the measurement actually
    has — rather than at a caller-supplied figure, so the filter can't claim two
    strings are distinguishable when this block length cannot distinguish them.

    Returns {'attacks': [(string, midi, freq, t_seconds)], 'tracked', 'skipped'}.
    """
    tracked = trackable_strings(frets, tuning, bin_hz=BIN_HZ,
                               min_bins=MIN_SEP_BINS)
    all_sounding = {m for _, m in voicing_midi(frets, tuning)}
    attacks = []
    for s, midi, freq in tracked:
        times, mags = goertzel_envelope_fast(x, freq, sr)
        t = attack_time(times, mags)
        if t is not None:
            attacks.append((s, midi, freq, t))
    attacks.sort(key=lambda a: a[3])
    skipped = len(all_sounding) - len(tracked)
    return {"attacks": attacks, "skipped": skipped, "tracked": len(tracked)}


# Attack times closer together than this are treated as simultaneous.
#
# Calibrated, not guessed. A string sounded ALONE has its 50% crossing located to
# better than 0.1ms, and the latency is near-identical across the frequency range
# (~-0.5ms at every string), so it cancels in a difference. But when strings sound
# TOGETHER, each one's narrowband envelope picks up leakage from its neighbours,
# and the crossing shifts by an amount that depends on the voicing: measured at a
# true 0ms stagger, C spreads 2.8ms, G 2.6ms, Am 1.9ms, F 0.8ms. That is
# deterministic (identical across noise seeds) and is the real resolution floor of
# this method — it is a property of the strings' spectra overlapping, not of the
# estimator being sloppy.
#
# 4ms sits just above the worst observed case, so a pair separated by less than
# that is reported as unknown rather than guessed. It also means the method cannot
# resolve a genuine sub-4ms strum: if real playing turns out to stagger that
# tightly, that is the gate failing, and no threshold here can rescue it.
# Worst spread measured at a TRUE 0ms stagger across the tested shapes (C 2.8, G
# 2.6, Am 1.9, F 0.8ms). This is the method's resolution floor.
LEAKAGE_FLOOR_MS = 2.8
# A pair of attacks must be separated by MORE than this to count as ordered at all.
# Set above the leakage floor with a little headroom: below it, the sign of the
# difference is an artifact of overlapping spectra, not of the player's hand.
MIN_SEPARATION_MS = 4.0
# Separation at which a pair contributes full confidence. Between MIN_SEPARATION_MS
# and this, confidence ramps, so the margin means "how sure are we of the order".
FULL_CONFIDENCE_MS = 12.0
# Below this weighted margin the direction is reported as unknown.
MIN_MARGIN = 0.3


def pair_confidence(dt_ms, min_ms=MIN_SEPARATION_MS, full_ms=FULL_CONFIDENCE_MS):
    """How much a pair of attacks `dt_ms` apart tells us about their ORDER, 0..1.

    Zero below `min_ms`, because below the leakage floor the sign of the difference
    is an artifact of overlapping spectra rather than of the player's hand. Ramps
    linearly to 1 at `full_ms`. This is the function the shipped detector's
    confidence would be built on, so it is deliberately a named, testable thing
    rather than an inline expression.
    """
    d = abs(dt_ms)
    if d <= min_ms:
        return 0.0
    if d >= full_ms:
        return 1.0
    return (d - min_ms) / (full_ms - min_ms)


def classify(attacks, frets, tuning):
    """Match an observed attack order against the down/up templates.

    Returns (direction, margin). `direction` is 'down' | 'up' | None (unknown), and
    `margin` is how much better the winning template fit, 0..1.

    Scoring counts CONCORDANT PAIRS: for each pair of observed attacks, does the
    template agree about which came first? That is robust to a missing string (a
    muted or undetected attack just removes pairs) and to unisons (already filtered
    out of `attacks`) in a way strict sequence equality would not be.

    Each pair is weighted by `pair_confidence`, and the weight is divided by the
    PAIR COUNT rather than by the weight sum. Normalising by the weight sum would
    make the score a pure ratio, and with a single pair — the common case, since
    most shapes have only two trackable strings — that ratio is 1.0 for whichever
    template wins, no matter how close the attacks were. Keeping the weight in the
    numerator lets a near-simultaneous pair produce a genuinely small margin, which
    is what makes "unknown" reachable at all.
    """
    if len(attacks) < 2:
        return None, 0.0
    down, up = templates(frets, tuning)
    observed = [(midi, t) for _, midi, _, t in attacks]

    def score(template):
        rank = {m: i for i, m in enumerate(template)}
        good = 0.0
        pairs = 0
        for i in range(len(observed)):
            for j in range(i + 1, len(observed)):
                (a, ta), (b, tb) = observed[i], observed[j]
                if a not in rank or b not in rank:
                    continue
                pairs += 1
                w = pair_confidence((tb - ta) * 1000.0)
                if (rank[a] < rank[b]) == (ta < tb):
                    good += w
        return (good / pairs if pairs else 0.0), pairs

    (sd_, pairs) = score(down)
    (su, _) = score(up)
    if not pairs or sd_ == su:
        return None, 0.0
    margin = abs(sd_ - su)
    # No pair was separated enough to trust its order: as far as this method can
    # tell the strings were struck together, so claim nothing.
    if margin < MIN_MARGIN:
        return None, margin
    return ("down" if sd_ > su else "up"), margin


def onset_ratios(x, sr=SR):
    """What flux ratios this audio actually produces, to check ONSET_RATIO.

    Mirrors the shipped detector's approach (audio.rs track_onset): summed
    positive spectral flux over the chord band, divided by a slow EMA baseline.
    """
    n = 2048
    hop = 256
    lo = int(65.0 / (sr / n))
    hi = int(1050.0 / (sr / n))
    win = np.hanning(n)
    prev = None
    baseline = 0.0
    ratios = []
    for i in range(0, len(x) - n, hop):
        mag = np.abs(np.fft.rfft(x[i:i + n] * win))[lo:hi]
        if prev is not None:
            flux = float(np.sum(np.maximum(0.0, mag - prev)))
            if baseline > 1e-9:
                ratios.append(flux / baseline)
            baseline = 0.05 * flux + 0.95 * baseline
        else:
            baseline = float(np.sum(mag)) * 0.1
        prev = mag
    return np.array(ratios)


# ---------------------------------------------------------------------------
# synthetic self-test
# ---------------------------------------------------------------------------

# Silence before the first attack in a synthetic strum. Must exceed the Goertzel
# block length: the envelope's first sample is centred BLOCK/2 into the signal, so
# a strum starting at t=0 has its entire rising edge inside the first block and no
# attack can be located. Real takes get this for free (find_strums backs up before
# each detected strum), but the synthetic case has to be built with it.
SYNTH_LEAD_MS = 80.0


def synth_strum(frets, tuning, direction, stagger_ms, dur=1.2, sr=SR,
                n_harmonics=6, seed=0, lead_ms=SYNTH_LEAD_MS):
    """Render a strum with a KNOWN per-string stagger and direction.

    Returns (signal, first_attack_seconds) so a test can check measured attack
    times against the truth rather than only their ordering.

    The prototype's feedback.synth_fingering can't be reused here: it starts every
    string at t=0, which is precisely the information this study is about.
    """
    rng = np.random.default_rng(seed)
    lead = lead_ms / 1000.0
    t = np.linspace(0, dur + lead, int(sr * (dur + lead)), endpoint=False)
    sig = np.zeros_like(t)
    order = voicing_midi(frets, tuning)
    if direction == "up":
        order = order[::-1]
    for k, (_, midi) in enumerate(order):
        f = midi_to_freq(midi)
        delay = lead + k * stagger_ms / 1000.0
        d = int(delay * sr)
        env_t = np.maximum(0.0, t - delay)
        tone = sum((1.0 / h) * np.sin(2 * np.pi * f * h * env_t)
                   for h in range(1, n_harmonics + 1))
        tone *= np.exp(-3.0 * env_t)
        tone[:d] = 0.0
        sig += tone
    sig += rng.normal(0, 1e-4, len(sig))  # a little noise, as in a real room
    peak = np.max(np.abs(sig))
    return (sig / peak if peak else sig), lead


def self_test(tuning="standard", verbose=False):
    """Verify the harness recovers KNOWN stagger and direction.

    This gates the gate. Without it, a bug here is indistinguishable from a
    physics result, and we'd either build on a false premise or abandon a workable
    idea because of an off-by-one.
    """
    voicings = load_voicings(tuning)
    # C/G: direction decidable from attack 1. Am/F: first attack is a unison, so
    # only the second attack onward decides it — the case most likely to break.
    shapes = [c for c in ("C", "G", "Am", "F") if c in voicings]
    # Above the floor, direction MUST be recovered. At or below it the honest
    # answer is "unknown", and reporting a direction anyway would be the failure —
    # so those rows are informational, and only a WRONG direction counts against.
    staggers = [15.0, 8.0, 5.0, 3.0, 2.0]
    # A true stagger must clear the leakage floor plus the confidence ramp before
    # this method can be expected to decide. Below it, "unknown" is correct.
    RESOLVABLE_MS = 8.0

    print("SELF-TEST — synthetic strums with known stagger and direction")
    print(f"  hop {HOP_MS}ms, Goertzel block {BLOCK} ({1000*BLOCK/SR:.1f}ms), "
          f"bin {BIN_HZ:.1f}Hz, leakage floor {LEAKAGE_FLOOR_MS}ms, "
          f"min margin {MIN_MARGIN}")
    print(f"  stagger >= {RESOLVABLE_MS}ms must classify; below that, 'None' "
          f"(unknown) is the correct answer\n")

    failures = []
    for chord in shapes:
        frets = voicings[chord]
        k = divergence_index(frets, tuning)
        tracked = trackable_strings(frets, tuning, bin_hz=BIN_HZ,
                               min_bins=MIN_SEP_BINS)
        note = " (unison first attack)" if k == 2 else ""
        print(f"  {chord} {frets}  decidable@{k}{note}, "
              f"{len(tracked)}/4 strings trackable")
        for stagger in staggers:
            for direction in ("down", "up"):
                x, _ = synth_strum(frets, tuning, direction, stagger)
                m = measure_strum(x, frets, tuning)
                got, margin = classify(m["attacks"], frets, tuning)
                # Two distinct failures: getting the direction WRONG (always bad),
                # and failing to decide when the stagger was big enough to resolve.
                wrong = got is not None and got != direction
                undecided_but_should_have = got is None and stagger >= RESOLVABLE_MS
                ok = not wrong and not undecided_but_should_have
                # Measured stagger between consecutive attacks. The truth here is
                # the stagger between the two TRACKED strings, which may not be
                # adjacent in the voicing — a filtered-out unison sits between
                # them — so scale by their separation in the sweep order.
                ts = [a[3] for a in m["attacks"]]
                gaps = np.abs(np.diff(ts)) * 1000 if len(ts) > 1 else np.array([])
                med = np.median(gaps) if len(gaps) else float("nan")
                # Expected gap between the tracked pair, per the sweep order.
                order = [mi for _, mi in voicing_midi(frets, tuning)]
                if direction == "up":
                    order = order[::-1]
                pos = [order.index(a[1]) for a in m["attacks"]]
                expect = abs(pos[1] - pos[0]) * stagger if len(pos) > 1 else float("nan")
                err = abs(med - expect) if len(gaps) else float("nan")
                if wrong:
                    flag = "WRONG"
                elif got is None:
                    flag = "unknown" if stagger < RESOLVABLE_MS else "MISSED"
                else:
                    flag = "ok"
                print(f"      {stagger:5.1f}ms {direction:4s} -> {str(got):5s} "
                      f"margin {margin:.2f}  gap {med:5.1f}ms "
                      f"(expect {expect:5.1f}, err {err:4.1f})  {flag}")
                if not ok:
                    failures.append((chord, stagger, direction, got, flag))

    # Control: strings struck together must NOT yield a direction. If the harness
    # "detects" one here it is reading leakage, and every positive result it
    # reports elsewhere would be suspect. Several noise seeds, because a single
    # lucky seed proves nothing.
    print("\n  CONTROL — 0ms stagger (all strings together): must report unknown")
    control_bad = []
    for chord in shapes:
        frets = voicings[chord]
        claims = []
        for seed in range(6):
            x, _ = synth_strum(frets, tuning, "down", 0.0, seed=seed)
            m = measure_strum(x, frets, tuning)
            got, margin = classify(m["attacks"], frets, tuning)
            claims.append((got, margin))
        confident = [(g, mg) for g, mg in claims if g is not None]
        worst = max((mg for _, mg in claims), default=0.0)
        bad = bool(confident)
        print(f"      {chord:4s} claimed a direction in {len(confident)}/6 seeds "
              f"(max margin {worst:.2f})  "
              f"{'FAIL — confident on simultaneous strings' if bad else 'ok'}")
        if bad:
            control_bad.append(chord)

    print()
    if failures or control_bad:
        wrongs = [f for f in failures if f[4] == "WRONG"]
        missed = [f for f in failures if f[4] == "MISSED"]
        if wrongs:
            print(f"{len(wrongs)} WRONG direction(s) — the method reported the "
                  f"opposite of the truth")
        if missed:
            print(f"{len(missed)} MISSED — resolvable stagger "
                  f"(>= {RESOLVABLE_MS}ms) went undecided")
        if control_bad:
            print(f"control failed for {', '.join(control_bad)}: a simultaneous "
                  f"strum produced a confident direction")
        return False
    print(f"self-test passed: direction recovered for stagger >= {RESOLVABLE_MS}ms, "
          f"never reported wrong, and")
    print(f"simultaneous strings correctly report unknown. The floor is "
          f"~{LEAKAGE_FLOOR_MS}ms, set by spectral")
    print("leakage between strings rather than by the estimator.")
    return True



# ---------------------------------------------------------------------------
# real takes
# ---------------------------------------------------------------------------

def load_take(path):
    """Load a take's audio plus whatever metadata sits beside it.

    Two producers, two sidecar formats — accepting both means a strum_lab session
    can be re-analysed by exactly the same code as a record_strums take:
      - record_strums.py writes `<name>_meta.npy` (pickled dict)
      - strum_lab.py writes `<name>.meta.json`
    """
    x = np.load(path)
    meta = {}
    json_meta = path[:-len(".npy")] + ".meta.json" if path.endswith(".npy") else ""
    npy_meta = path.replace(".npy", "_meta.npy")
    if json_meta and os.path.exists(json_meta):
        import json as _json
        with open(json_meta) as fh:
            meta = _json.load(fh)
    elif os.path.exists(npy_meta):
        meta = np.load(npy_meta, allow_pickle=True).item()
    else:
        # Fall back to the filename: strums_<chord>_<dir>.npy
        base = os.path.basename(path)
        if base.startswith("strums_"):
            base = base[len("strums_"):-len(".npy")]
            parts = base.rsplit("_", 1)
            if len(parts) == 2:
                meta = {"chord": parts[0], "direction": parts[1],
                        "tuning": "standard", "sr": SR}
    return np.ascontiguousarray(x, dtype=np.float64), meta


def load_strum_log(path):
    """The lab's per-strum log, if this take has one.

    A lab session that switched shapes mid-recording can only be split correctly
    from here: it records the target each strum was actually played against, where
    the sidecar records one target for the whole file.
    """
    log = path[:-len(".npy")] + ".strums.jsonl" if path.endswith(".npy") else ""
    if not log or not os.path.exists(log):
        return []
    import json as _json
    out = []
    with open(log) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(_json.loads(line))
                except ValueError:
                    pass
    return out


def analyse_session(path, verbose=False):
    """Analyse one take, splitting a mixed lab session by shape.

    Returns a list of results — one per (chord, direction) actually played — so a
    session where the shape was switched isn't averaged into a single figure
    computed with one shape's probe frequencies.
    """
    _, meta = load_take(path)
    log = load_strum_log(path)
    targets = meta.get("targets")
    if not targets and log:
        # Older sessions have no `targets`; recover them from the log.
        seen, targets = set(), []
        for s in log:
            k = (s["chord"], s["expected"])
            if k not in seen:
                seen.add(k)
                targets.append({"chord": s["chord"], "direction": s["expected"]})
    if not targets:
        r = analyse_take(path, verbose=verbose)
        return [r] if r else []
    if len(targets) == 1:
        r = analyse_take(path, verbose=verbose,
                         chord=targets[0]["chord"],
                         direction=targets[0]["direction"])
        return [r] if r else []

    print(f"\n{os.path.basename(path)}: mixed session — "
          f"{len(targets)} targets, analysing each separately")
    out = []
    for t in targets:
        r = analyse_take(path, verbose=verbose, chord=t["chord"],
                         direction=t["direction"], log=log)
        if r:
            out.append(r)
    return out


def analyse_take(path, verbose=False, chord=None, direction=None, log=None):
    x, meta = load_take(path)
    chord = chord or meta.get("chord")
    direction = direction or meta.get("direction")
    tuning = meta.get("tuning", "standard")
    if not chord or not direction:
        print(f"  {path}: can't tell which chord/direction this is — skipping")
        return None

    voicings = load_voicings(tuning)
    if chord not in voicings:
        print(f"  {path}: '{chord}' not in the {tuning} table — skipping")
        return None
    frets = voicings[chord]
    tracked = trackable_strings(frets, tuning, bin_hz=BIN_HZ,
                               min_bins=MIN_SEP_BINS)

    starts = find_strums(x)
    if log:
        # Mixed session: keep only the strums played against THIS target. The log's
        # timestamps are wall-clock, so match by ordinal — both the log and
        # find_strums see the same strums in the same order.
        want = [i for i, s in enumerate(log)
                if s["chord"] == chord and s["expected"] == direction]
        if len(log) == len(starts):
            starts = [starts[i] for i in want]
        else:
            # Counts disagree, so an ordinal match would silently pair the wrong
            # strums. Say so rather than reporting a confident mismatch.
            print(f"  note: log has {len(log)} strums but {len(starts)} were found "
                  f"in the audio — analysing all of them as {chord}")
    print(f"\n{os.path.basename(path)}  {chord} {frets} {direction}stroke"
          f"  ({len(starts)} strums found, {len(tracked)}/4 strings trackable)")
    if len(tracked) < 2:
        print("  fewer than 2 trackable strings — this shape can't be classified")
        return None

    span = int(0.12 * SR)  # analyse 120ms from each strum start
    # Silence kept BEFORE the onset, and it has to exceed the Goertzel half-window
    # (BLOCK/2 = 23.2ms): the envelope's first sample is centred there, so with less
    # lead-in the rising edge sits inside the first block and attack_time correctly
    # refuses to locate it. This path used 5ms and consequently measured almost
    # nothing on a real session — 1 of 23 strums — while the live rig, which uses
    # 60ms, measured them fine. Raising it to 60 recovered 11 of 23; the rest are
    # strums whose neighbours were still ringing.
    lead = int(0.060 * SR)
    gaps, margins, spans = [], [], []
    correct = wrong = unknown = usable = 0
    for i, s in enumerate(starts):
        seg = x[max(0, s - lead):s + span]
        m = measure_strum(seg, frets, tuning)
        if len(m["attacks"]) < 2:
            continue
        usable += 1
        ts = [a[3] for a in m["attacks"]]
        g = np.diff(ts) * 1000
        gaps.extend(g)
        spans.append((ts[-1] - ts[0]) * 1000)
        got, margin = classify(m["attacks"], frets, tuning)
        margins.append(margin)
        # Three outcomes, and the distinction matters: a WRONG direction would
        # mislead the player, whereas UNKNOWN just means no glyph is drawn. A
        # method that is rarely wrong but usually unsure is still shippable; one
        # that is confidently wrong is not.
        if got is None:
            unknown += 1
        elif got == direction:
            correct += 1
        else:
            wrong += 1
        if verbose:
            seq = " -> ".join(f"{midi_to_name(a[1])}@{a[3]*1000:.1f}ms"
                             for a in m["attacks"])
            print(f"    strum {i+1:2d}: {seq}  -> {got} (margin {margin:.2f})")

    if not usable:
        print("  no strum yielded 2+ measurable attacks")
        return None

    gaps = np.array(gaps)
    ratios = onset_ratios(x)
    decided = correct + wrong
    result = {
        "chord": chord, "direction": direction, "strums": usable,
        # How many strings this shape could actually order. Reported because it is
        # the strongest predictor of reliability: a shape with one usable pair has
        # nothing to outvote a single mis-ordered pair, while four tracked strings
        # give three pairs and can absorb one bad reading.
        "tracked": len(tracked),
        "gap_median": float(np.median(gaps)),
        "gap_p10": float(np.percentile(gaps, 10)),
        "gap_p90": float(np.percentile(gaps, 90)),
        "span_median": float(np.median(spans)),
        # Accuracy AMONG DECIDED strums: the risk of showing a wrong glyph.
        "accuracy": (correct / decided) if decided else float("nan"),
        # How often the method commits at all: the coverage it would give a player.
        "decided_rate": decided / usable,
        "wrong": wrong,
        "margin_median": float(np.median(margins)),
        "onset_p95": float(np.percentile(ratios, 95)) if len(ratios) else float("nan"),
    }
    print(f"  inter-string gap: median {result['gap_median']:.1f}ms "
          f"(p10 {result['gap_p10']:.1f} .. p90 {result['gap_p90']:.1f})")
    print(f"  full strum span:  median {result['span_median']:.1f}ms")
    print(f"  direction:        {correct} right, {wrong} wrong, {unknown} unknown "
          f"of {usable}  (median margin {result['margin_median']:.2f})")
    return result


def verdict(results):
    """The decision gate, stated plainly."""
    if not results:
        print("\nNo usable takes — nothing to conclude.")
        return
    gaps = [r["gap_median"] for r in results]
    accs = [r["accuracy"] for r in results if not np.isnan(r["accuracy"])]
    coverage = [r["decided_rate"] for r in results]
    wrongs = sum(r["wrong"] for r in results)
    total = sum(r["strums"] for r in results)
    margins = [r["margin_median"] for r in results]
    onsets = [r["onset_p95"] for r in results if not np.isnan(r["onset_p95"])]

    print("\n" + "=" * 68)
    print("VERDICT")
    print("=" * 68)
    # Per shape first. Reliability tracks how many strings a shape can order, and
    # that difference decides whether direction detection should be shape-gated in
    # the app rather than offered everywhere.
    if len(results) > 1:
        print(f"  {'shape':6s}{'dir':6s}{'strings':>8s}{'n':>4s}{'right':>6s}"
              f"{'wrong':>6s}{'unk':>5s}{'gap':>7s}")
        for r in sorted(results, key=lambda r: (-r["tracked"], r["chord"])):
            n = r["strums"]
            dec = round(r["decided_rate"] * n)
            right = round(dec * (r["accuracy"] if not np.isnan(r["accuracy"]) else 0))
            print(f"  {r['chord']:6s}{r['direction']:6s}{r['tracked']:>8d}{n:>4d}"
                  f"{right:>6d}{r['wrong']:>6d}{n - dec:>5d}"
                  f"{r['gap_median']:>6.1f}ms")
        print()
    print(f"  takes analysed:        {len(results)}  ({total} strums)")
    print(f"  median stagger:        {np.median(gaps):.1f}ms "
          f"(range {min(gaps):.1f} .. {max(gaps):.1f})")
    print(f"  method needs:          ~{LEAKAGE_FLOOR_MS}ms floor, "
          f"{MIN_SEPARATION_MS}ms to commit (measured, see --synthetic)")
    print(f"  decided:               {100*np.mean(coverage):.0f}% of strums "
          f"(the rest reported unknown)")
    if accs:
        print(f"  correct when decided:  {100*np.mean(accs):.0f}%  "
              f"({wrongs} wrong out of {total})")
    print(f"  median margin:         {np.median(margins):.2f}")
    if onsets:
        print(f"  onset flux ratio p95:  {np.median(onsets):.1f} "
              f"(shipped ONSET_RATIO = {SHIPPED_ONSET_RATIO})")

    # Thresholds reflect what the method actually requires, established by the
    # synthetic self-test rather than assumed up front.
    #
    # The gate is decided on OUTCOMES (is it wrong? does it commit?), with stagger
    # as supporting evidence only. An earlier version gated on `min(gaps) >= floor`
    # and declared failure on takes that classified 100% correctly: one shape whose
    # tracked strings sit adjacent in the sweep has a small median gap by
    # construction, which says nothing about whether direction was recoverable.
    # What matters is whether the method is right and whether it answers.
    stagger_ok = np.median(gaps) >= MIN_SEPARATION_MS
    # Being WRONG is the disqualifying failure — a wrong glyph actively misleads.
    # Being unsure is merely a coverage limit.
    safe = bool(accs) and np.mean(accs) >= 0.95 and wrongs <= max(1, total // 50)
    useful = np.mean(coverage) >= 0.5

    print()
    if safe and useful:
        print("  GATE CLEARED. The method commits often enough to be worth showing")
        print("  and is essentially never wrong. Proceed to the short-hop detector")
        print("  in audio.rs, using the median margin above as the confidence")
        print("  floor.")
        if not stagger_ok:
            print()
            print("  Note: the median stagger is below the commit threshold, so the")
            print("  coverage above is carried by the wider-spread strums. Expect")
            print("  direction to be reported on some strums and not others.")
    elif safe and not useful:
        print("  PARTIAL. The method is not wrong when it commits, but it is unsure")
        print("  too often to carry a player-facing glyph. Options: show direction")
        print("  only on the strums it is sure about (honest, but sparse), or treat")
        print("  this as diagnostics-only for now. Do NOT lower the confidence")
        print("  floor to increase coverage — that converts 'unsure' into 'wrong'.")
    elif not safe:
        print("  GATE NOT CLEARED. The method reports the WRONG direction too often")
        print("  to put in front of a player. Do not build on it as-is.")
        print("  Remaining options: the camera route, or a song-supplied strum")
        print("  pattern scored against onset COUNT — which needs nothing new,")
        print("  since onset detection already ships.")
    else:
        print("  GATE NOT CLEARED. Real stagger is at or below the leakage floor")
        print("  this method can resolve, so the ordering isn't recoverable from")
        print("  narrowband envelopes. A shorter hop will NOT fix it: the limit is")
        print("  spectral overlap between the strings, not time resolution.")
        print("  Remaining options: the camera route, or a song-supplied strum")
        print("  pattern scored against onset COUNT (needs nothing new).")
    # Onset health. Note the failure that actually occurred was the OPPOSITE of the
    # one this originally warned about: the threshold was fine (real p95 ≈ 2.8 vs a
    # shipped 2.2) and the detector over-fired instead, counting one strum 2-3 times,
    # because a scale-free ratio inflates ring-out once its baseline decays. So check
    # the COUNT, not just the threshold — a count is what every timing feature is
    # built on.
    if onsets:
        p95 = float(np.median(onsets))
        print()
        if p95 < SHIPPED_ONSET_RATIO:
            print(f"  ONSET CHECK: real audio peaks around {p95:.1f}x baseline, below "
                  f"the shipped\n  ONSET_RATIO of {SHIPPED_ONSET_RATIO} — strums are "
                  "likely being missed.")
        else:
            print(f"  ONSET CHECK: threshold looks right (real p95 {p95:.1f}x vs "
                  f"shipped {SHIPPED_ONSET_RATIO}).")
            print("  Over-firing is the more likely fault and is not visible here —")
            print("  see the real-audio regression test in audio.rs, which asserts "
                  "the")
            print("  onset COUNT against a known number of strums.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    # Takes from record_strums.py and sessions from strum_lab.py are both just
    # .npy plus a sidecar, so one positional argument covers both — no separate
    # --session flag, which would only be a second name for the same code path.
    ap.add_argument("paths", nargs="*",
                    help="clips/strums_*.npy or clips/lab_*.npy")
    ap.add_argument("--synthetic", action="store_true",
                    help="self-test on synthetic strums with known stagger")
    ap.add_argument("--self-check", action="store_true",
                    help="verify the fast Goertzel matches the scalar reference")
    ap.add_argument("--tuning", choices=sorted(TUNINGS), default="standard")
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="print per-strum attack sequences")
    args = ap.parse_args()

    if args.self_check:
        x, _ = synth_strum(load_voicings(args.tuning)["C"], args.tuning, "down", 5.0)
        f = midi_to_freq(67)
        t1, m1 = goertzel_envelope(x[:4096], f)
        t2, m2 = goertzel_envelope_fast(np.ascontiguousarray(x[:4096]), f)
        err = np.max(np.abs(m1 - m2)) / max(1e-12, np.max(m1))
        print(f"fast vs reference Goertzel: max relative error {err:.2e}")
        sys.exit(0 if err < 1e-6 else 1)

    if args.synthetic:
        sys.exit(0 if self_test(args.tuning, args.verbose) else 1)

    paths = []
    for p in args.paths:
        paths.extend(sorted(glob.glob(p)) if "*" in p else [p])
    paths = [p for p in paths if not p.endswith("_meta.npy")]
    if not paths:
        print("nothing to analyse. Record some takes first:")
        print("  python record_strums.py --plan")
        sys.exit(1)

    results = [r for p in paths for r in analyse_session(p, args.verbose)]
    verdict(results)
