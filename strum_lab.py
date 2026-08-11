"""Live strum-direction lab — play into the mic, see whether direction is
recoverable, in real time.

    .venv/bin/python strum_lab.py
    open http://localhost:8766

WHY A LIVE RIG
--------------
analyse_strums.py answers the question offline, but it has a trap: it decides
WHICH FREQUENCIES to track from an assumed voicing. Play a different C shape than
the one in the table and it tracks the wrong strings, producing numbers that look
like a physics result and are actually a mismatch. This page shows the exact
fingering it is listening for, so player and analyser agree by construction.

The other thing offline takes can't give you is the speed sweep. The synthetic
study found this method needs roughly 8ms of stagger to commit (the floor is
spectral leakage between strings — see analyse_strums.py). A slow deliberate strum
should clear that easily; a fast one may collapse below it. Where exactly that
happens decides whether the feature is viable for real playing, and you can only
find out by playing at several tempos and watching.

Analysis is IMPORTED from analyse_strums, not reimplemented — the lab and the
offline study must never disagree about what a strum measured.

Stdlib + numpy + sounddevice, like server.py, whose SSE pattern this follows.
"""

import json
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd

from analyse_strums import (BLOCK, FULL_CONFIDENCE_MS, LEAKAGE_FLOOR_MS,
                            MIN_MARGIN, MIN_SEPARATION_MS, MIN_SEP_BINS, SR,
                            classify, measure_strum)
from strum_model import (TUNINGS, divergence_index, load_voicings, midi_to_name,
                         templates, trackable_strings)

PORT = 8766
PAGE = "strum_lab.html"

# Audio is captured in short chunks so a strum is noticed promptly, then analysed
# over a longer slice pulled from the ring buffer.
CHUNK = 1024
# How much audio each strum is measured over. Must comfortably exceed the Goertzel
# block (2048 = 46ms) plus the widest stagger we care about.
ANALYSE_MS = 140.0
# Silence kept BEFORE the strum's onset. The envelope's first sample is centred
# BLOCK/2 into the slice, so without lead-in the rising edge is inside the first
# block and no attack can be located — the bug the synthetic study hit first.
LEAD_MS = 60.0
# Ring buffer: enough for lead-in + analysis window + slack.
RING_SEC = 1.0

# Onset detection for segmenting strums. Deliberately simpler than audio.rs's
# spectral flux: here we only need to know a strum happened and roughly when, and
# the per-string timing is measured separately and precisely.
ONSET_RMS_RATIO = 2.5
# One strum = one onset. 90ms allows 16ths at 160bpm (~94ms apart) while covering
# the attack itself.
ONSET_REFRACTORY_MS = 90.0
# An onset is a RISE, not a level. Measured on synthetic strums, a plucked note's
# chunk-RMS decays by a factor of ~0.93 per 23ms chunk, so any level-based test
# ("louder than a fraction of the recent peak") keeps firing on the ringing tail —
# which is exactly what happened: 6 strums produced 24 onsets. Requiring the level
# to be RISING separates a new attack from a decay unambiguously, because a decaying
# string never rises.
ONSET_RISE_RATIO = 1.30    # chunk RMS must exceed the previous chunk by this much
# Absolute floor for what counts as a strum at all. Room noise on a laptop mic
# passes a purely relative test — during a smoke run, background hiss at peak 0.02
# produced two confident (and meaningless) direction calls. A rig that measures
# silence and reports a direction would poison the study it exists to inform, so a
# strum must actually be audible. Raise this if quiet room noise still triggers.
ONSET_MIN_PEAK = 0.05

# The drill: speed is the variable that matters most, since it decides whether the
# stagger clears the leakage floor. Shapes cover both decision paths — C/G settle
# on the first attack, Am/F only on the second (their first attack is a unison).
DRILL_BPMS = [60, 90, 120, 160]
DRILL_SHAPES = ["C", "Am", "G", "F"]
DRILL_STRUMS = 8  # per (shape, direction, bpm) cell

_lock = threading.Lock()
_events = deque(maxlen=64)   # measured strums awaiting delivery to the browser
_seq = {"n": 0}
_target = {"chord": "C", "direction": "down", "bpm": 60, "tuning": "standard"}
_mic = {"sr": SR, "name": "?", "rms": 0.0, "floor": 0.0}


def shape_info(chord, tuning):
    """Everything the page needs to render the shape and explain the measurement."""
    voicings = load_voicings(tuning)
    frets = voicings.get(chord)
    if frets is None:
        return None
    tracked = trackable_strings(frets, tuning, bin_hz=SR / BLOCK,
                                min_bins=MIN_SEP_BINS)
    down, up = templates(frets, tuning)
    return {
        "chord": chord,
        "frets": [None if f is None else int(f) for f in frets],
        "tuning": tuning,
        "spelling": TUNINGS[tuning]["spelling"],
        "stringLabels": _string_labels(tuning),
        # Which strings the measurement can actually use, and which it must skip.
        # Showing this is the point: a unison string contributes nothing, and the
        # player should know the reading rests on two strings, not four.
        "tracked": [{"string": s, "note": midi_to_name(m), "freq": round(f, 1)}
                    for s, m, f in tracked],
        "decidesAt": divergence_index(frets, tuning),
        "down": [midi_to_name(m) for m in down],
        "up": [midi_to_name(m) for m in up],
    }


def _string_labels(tuning):
    """Open-string note names in physical order (string 4 first)."""
    return [midi_to_name(m)[:-1] for m in TUNINGS[tuning]["open_midi"]]


# --------------------------------------------------------------------------
# audio
# --------------------------------------------------------------------------
class Listener:
    """Rolling capture + onset segmentation + per-strum measurement."""

    def __init__(self, sr):
        self.sr = sr
        self.ring = np.zeros(int(RING_SEC * sr))
        self.written = 0            # total samples ever written
        self.floor = 1e-4           # running noise floor (chases silence)
        self.prev_rms = 0.0         # previous chunk, for the rise test
        self.last_onset_sample = -10 ** 9
        self.pending = None         # strum awaiting enough trailing audio

    def push(self, chunk):
        n = len(chunk)
        if n >= len(self.ring):
            self.ring[:] = chunk[-len(self.ring):]
        else:
            self.ring = np.roll(self.ring, -n)
            self.ring[-n:] = chunk
        self.written += n

        rms = float(np.sqrt(np.mean(chunk ** 2)))
        _mic["rms"] = rms
        _mic["floor"] = self.floor

        # Two conditions, each catching what the other misses:
        #   - above the noise FLOOR: there is signal at all
        #   - RISING vs the previous chunk: this is an attack, not a decaying tail
        loud_enough = rms > self.floor * ONSET_RMS_RATIO and rms > 0.005
        rising = rms > self.prev_rms * ONSET_RISE_RATIO
        attacking = loud_enough and rising
        refractory = (self.written - self.last_onset_sample) < \
            (ONSET_REFRACTORY_MS / 1000.0 * self.sr)
        # `pending is None` as well as the refractory: a marker must never be moved
        # once set, or the slice loses its lead-in silence and the rising edge ends
        # up inside the first Goertzel block, where no attack can be located.
        if attacking and not refractory and self.pending is None:
            self.last_onset_sample = self.written - n
            self.pending = self.written - n   # measured once enough audio arrives
        if not loud_enough:
            self.floor = 0.05 * rms + 0.95 * self.floor
        self.prev_rms = rms

        self._maybe_measure()

    def _maybe_measure(self):
        """Measure the pending strum once ANALYSE_MS of audio has followed it."""
        if self.pending is None:
            return
        lead = int(LEAD_MS / 1000.0 * self.sr)
        tail = int(ANALYSE_MS / 1000.0 * self.sr)
        if self.written - self.pending < tail:
            return  # strum still arriving

        start = self.pending - lead   # lead-in silence: see LEAD_MS
        end = self.pending + tail
        # Ring offsets. `written` is the absolute index one past the newest sample,
        # and the ring holds the most recent len(ring) samples, so absolute index i
        # sits at len(ring) - (written - i).
        lo = len(self.ring) - (self.written - start)
        hi = len(self.ring) - (self.written - end)
        if lo < 0 or hi > len(self.ring) or hi <= lo:
            # The strum fell off the back of the ring (a stall, or a very long
            # ANALYSE_MS). Drop it rather than measuring a wrapped slice.
            self.pending = None
            return
        self.pending = None
        seg = np.ascontiguousarray(self.ring[lo:hi])
        # Too quiet to be a strum. Reported rather than silently dropped: if the
        # lab looks unresponsive while you are clearly playing, this is why, and the
        # level meter tells you whether to move closer or lower ONSET_MIN_PEAK.
        if np.max(np.abs(seg)) < ONSET_MIN_PEAK:
            return
        self._emit(seg)

    def _emit(self, seg):
        with _lock:
            chord = _target["chord"]
            direction = _target["direction"]
            tuning = _target["tuning"]
        voicings = load_voicings(tuning)
        frets = voicings.get(chord)
        if frets is None:
            return

        m = measure_strum(seg, frets, tuning, sr=self.sr)
        got, margin = classify(m["attacks"], frets, tuning)
        ts = [a[3] for a in m["attacks"]]
        gaps = [abs(b - a) * 1000 for a, b in zip(ts, ts[1:])]

        _seq["n"] += 1
        event = {
            "seq": _seq["n"],
            "t": round(time.time(), 3),
            "chord": chord,
            "expected": direction,
            "bpm": _target["bpm"],
            "direction": got,
            "margin": round(margin, 3),
            # Right / wrong / unknown are three different things: a WRONG glyph
            # misleads a learner, unknown merely shows nothing.
            "outcome": ("unknown" if got is None
                        else "right" if got == direction else "wrong"),
            "attacks": [{"note": midi_to_name(a[1]), "freq": round(a[2], 1),
                         "ms": round(a[3] * 1000, 2)} for a in m["attacks"]],
            "gapMs": round(gaps[0], 2) if gaps else None,
            "tracked": m["tracked"],
            "peak": round(float(np.max(np.abs(seg))), 3),
        }
        with _lock:
            _events.append(event)


def audio_loop():
    dev = sd.query_devices(kind="input")
    _mic["name"] = dev["name"]
    # Ask for 44.1k even on a 48k device (CoreAudio resamples). The analysis
    # constants — BLOCK, BIN_HZ, the measured leakage floor — are all derived at
    # 44.1k, so matching the offline study matters more than avoiding a resample.
    sr = SR
    _mic["sr"] = sr
    listener = Listener(sr)

    def cb(indata, frames, tinfo, status):
        listener.push(indata[:, 0].astype(np.float64))

    with sd.InputStream(channels=1, samplerate=sr, blocksize=CHUNK, callback=cb):
        while True:
            sd.sleep(200)


# --------------------------------------------------------------------------
# HTTP / SSE
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            here = os.path.dirname(os.path.abspath(__file__))
            with open(os.path.join(here, PAGE), "rb") as f:
                self._send(200, "text/html", f.read())
        elif self.path == "/config":
            with _lock:
                target = dict(_target)
            self._send(200, "application/json", json.dumps({
                "target": target,
                "shape": shape_info(target["chord"], target["tuning"]),
                "shapes": DRILL_SHAPES,
                "bpms": DRILL_BPMS,
                "strumsPerCell": DRILL_STRUMS,
                "mic": {"name": _mic["name"], "sr": _mic["sr"]},
                "thresholds": {
                    "leakageFloorMs": LEAKAGE_FLOOR_MS,
                    "minSeparationMs": MIN_SEPARATION_MS,
                    "fullConfidenceMs": FULL_CONFIDENCE_MS,
                    "minMargin": MIN_MARGIN,
                },
            }).encode())
        elif self.path == "/stream":
            self._stream_sse()
        else:
            self._send(404, "text/plain", b"not found")

    def do_POST(self):
        if self.path == "/target":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            with _lock:
                for k in ("chord", "direction", "bpm", "tuning"):
                    if k in data:
                        _target[k] = data[k]
                target = dict(_target)
            self._send(200, "application/json", json.dumps({
                "target": target,
                "shape": shape_info(target["chord"], target["tuning"]),
            }).encode())
        else:
            self._send(404, "text/plain", b"not found")

    def _stream_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        sent = 0
        try:
            while True:
                with _lock:
                    new = [e for e in _events if e["seq"] > sent]
                    level = {"rms": round(_mic["rms"], 5),
                             "floor": round(_mic["floor"], 5)}
                for e in new:
                    sent = max(sent, e["seq"])
                    self.wfile.write(
                        f"data: {json.dumps({'type': 'strum', **e})}\n\n".encode())
                # A level tick doubles as an SSE keepalive and drives the meter, so
                # the page can show the mic is live before anything is played.
                self.wfile.write(
                    f"data: {json.dumps({'type': 'level', **level})}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    threading.Thread(target=audio_loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"strum lab: http://localhost:{PORT}")
    print(f"  mic: {sd.query_devices(kind='input')['name']} "
          f"(analysing at {SR}Hz to match the offline study)")
    print(f"  needs ~{MIN_SEPARATION_MS}ms of string stagger to call a direction; "
          f"floor is ~{LEAKAGE_FLOOR_MS}ms")
    print("  Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")




# --------------------------------------------------------------------------
# self-test
# --------------------------------------------------------------------------
def self_test():
    """Drive the Listener with synthetic strums — no mic, no browser.

    Checks the two things that are easy to get wrong and invisible once you're
    playing into it: that each strum produces exactly ONE onset (a decaying string
    must not re-trigger), and that the slice handed to the analyser has enough
    lead-in silence for the attack to be locatable at all.

    Both failed during development. The tail re-fired three times per strum, and an
    overwritten pending marker left the rising edge inside the first Goertzel block,
    so every strum reported "no attacks". Neither is apparent from the UI — you'd
    just see wrong numbers and blame the ukulele.
    """
    from analyse_strums import synth_strum

    print("SELF-TEST — synthetic strums through the live Listener")
    print(f"  chunk {CHUNK} ({1000*CHUNK/SR:.1f}ms), analyse {ANALYSE_MS}ms, "
          f"lead {LEAD_MS}ms, refractory {ONSET_REFRACTORY_MS}ms\n")
    voicings = load_voicings("standard")
    n = 6
    bad = []
    for bpm in DRILL_BPMS:
        for chord in DRILL_SHAPES:
            if chord not in voicings:
                continue
            for direction in ("down", "up"):
                spacing = 60.0 / bpm
                with _lock:
                    _target.update({"chord": chord, "direction": direction,
                                    "bpm": bpm, "tuning": "standard"})
                    _events.clear()
                    _seq["n"] = 0
                listener = Listener(SR)
                buf = np.zeros(int((0.4 + spacing * n + 0.5) * SR))
                for i in range(n):
                    x, _lead = synth_strum(voicings[chord], "standard", direction,
                                           12.0, dur=min(0.6, spacing * 0.95), seed=i)
                    s = int((0.4 + i * spacing) * SR)
                    m = min(len(x), len(buf) - s)
                    buf[s:s + m] += x[:m]
                peak = np.max(np.abs(buf))
                if peak:
                    buf = buf / peak * 0.5
                for i in range(0, len(buf) - CHUNK, CHUNK):
                    listener.push(buf[i:i + CHUNK])
                with _lock:
                    got = list(_events)
                outs = [e["outcome"] for e in got]
                wrong = outs.count("wrong")
                right = outs.count("right")
                ok = len(got) == n and wrong == 0 and right >= n - 1
                if not ok:
                    bad.append((bpm, chord, direction, len(got), right, wrong))
                print(f"  {bpm:3d}bpm {chord:3s} {direction:4s}: "
                      f"{len(got)} onsets (want {n}), {right} right, {wrong} wrong  "
                      f"{'ok' if ok else 'FAIL'}")
    print()
    if bad:
        for bpm, chord, d, n_got, right, wrong in bad:
            print(f"  FAIL {bpm}bpm {chord} {d}: {n_got} onsets, "
                  f"{right} right, {wrong} wrong")
        return False
    print("self-test passed: one onset per strum at every tempo, direction never "
          "wrong.\nA real ukulele is the actual test — this only proves the rig "
          "isn't lying to you.")
    return True


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        sys.exit(0 if self_test() else 1)
    main()
