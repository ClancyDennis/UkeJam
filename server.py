"""Live analysis server — real mic -> real engine -> browser visualization.

Runs the actual ukejam detection pipeline on your microphone and streams
frames (FFT spectrum, chromagram, detected chord, cleanliness score, missing/
extra notes) to the browser over Server-Sent Events. The page renders them in
the chosen "Warm Neon Lab" look, so you can SEE the engine respond to your uke.

Includes mic CALIBRATION (measures room noise floor, saves to config) — this is
a recurring setting, so it persists via config.py.

Stdlib + numpy + sounddevice only. Run:
    python server.py
then open http://localhost:8765
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd

from chords import build_templates, NOTE_NAMES
from config import load_config, save_config, apply_calibration
from feedback import diff_against_target
from fretboard import VOICINGS, expected_pitch_classes

# --- analysis constants ---
# 8192-sample window -> ~5.4 Hz bins at 44.1kHz, enough to separate adjacent
# low notes (e.g. E4 330Hz vs F4 349Hz) that 4096-bin resolution smears
# together. 186ms latency is fine for sustained chords.
BLOCK = 8192
SPECTRUM_BINS = 96          # downsampled spectrum sent to browser
FMIN_VIS, FMAX_VIS = 70.0, 2000.0

LABELS, TEMPLATES, PRIORS = build_templates()
CONFIG = load_config()

# Shared state filled by the audio thread, read by the SSE stream.
_state_lock = threading.Lock()
_latest = {"frame": None}
_target_chord = {"name": "G"}    # which chord the player is currently aiming at
_stream = {"sr": 44100}


# --------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------
def analyze_block(samples, sr):
    """Compute everything the UI needs from one audio block."""
    cfg = CONFIG
    samples = samples - np.mean(samples)
    rms = float(np.sqrt(np.mean(samples ** 2)))

    window = np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(samples * window))
    freqs = np.fft.rfftfreq(len(samples), 1.0 / sr)

    # --- chroma (same math as chords.compute_chroma, reused here so we can
    #     also emit the spectrum without a second FFT) ---
    chroma = np.zeros(12)
    cmask = (freqs >= cfg["fmin"]) & (freqs <= cfg["fmax"])
    f, mag = freqs[cmask], spectrum[cmask]
    if len(f):
        midi = 69 + 12 * np.log2(np.maximum(f, 1e-9) / 440.0)
        pc = np.round(midi).astype(int) % 12
        # suppress spectral-leakage skirts (see chords.compute_chroma)
        cents = np.abs(midi - np.round(midi))
        wmag = mag * np.maximum(0.0, np.cos(np.pi * cents)) ** 2
        for k in range(12):
            chroma[k] = wmag[pc == k].sum()
    cn = np.linalg.norm(chroma)
    chroma = chroma / cn if cn > 0 else chroma

    gated = rms >= cfg["rms_gate"]
    if gated and cn > 0:
        scores = TEMPLATES @ chroma
        ranked = scores * PRIORS          # prefer simpler chords on near-ties
        bi = int(np.argmax(ranked))
        detected = LABELS[bi]
        cleanliness = float(scores[bi])   # report raw cosine similarity
    else:
        detected, cleanliness = None, 0.0

    # --- cleanliness breakdown vs the target chord ---
    target = _target_chord["name"]
    missing, extra = [], []
    if target in VOICINGS and gated and cn > 0:
        missing, extra = diff_against_target(chroma, expected_pitch_classes(target))

    # --- downsample the visible spectrum to a fixed number of log-spaced bins ---
    vis = _log_spectrum(freqs, spectrum, FMIN_VIS, FMAX_VIS, SPECTRUM_BINS)

    # --- detected peaks with note labels (for the analyzer overlay) ---
    peaks = _find_peaks(freqs, spectrum, cfg["fmin"], cfg["fmax"])

    return {
        "t": round(time.time(), 3),
        "rms": round(rms, 5),
        "gated": gated,
        "detected": detected,
        "cleanliness": round(cleanliness, 4),
        "target": target,
        "missing": [NOTE_NAMES[p] for p in missing],
        "extra": [NOTE_NAMES[p] for p in extra],
        "chroma": [round(float(c), 4) for c in chroma],
        "spectrum": vis,
        "peaks": peaks,
        "noise_floor": cfg["noise_floor"],
        "rms_gate": cfg["rms_gate"],
    }


def _log_spectrum(freqs, spectrum, fmin, fmax, n):
    """Bin the spectrum into n log-spaced bands, normalized 0..1."""
    edges = np.logspace(np.log10(fmin), np.log10(fmax), n + 1)
    out = np.zeros(n)
    for i in range(n):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        if m.any():
            out[i] = spectrum[m].max()
    peak = out.max()
    if peak > 0:
        out = out / peak
    return [round(float(x), 3) for x in out]


def _find_peaks(freqs, spectrum, fmin, fmax, top=6):
    """Return [{freq, note, mag}] for the strongest spectral peaks."""
    m = (freqs >= fmin) & (freqs <= fmax)
    f, mag = freqs[m], spectrum[m]
    if len(f) < 3:
        return []
    # local maxima
    idx = [i for i in range(1, len(mag) - 1)
           if mag[i] > mag[i - 1] and mag[i] > mag[i + 1]]
    idx.sort(key=lambda i: mag[i], reverse=True)
    peaks = []
    mx = mag.max() or 1.0
    for i in idx[:top]:
        fr = float(f[i])
        midi = int(round(69 + 12 * np.log2(fr / 440.0)))
        note = NOTE_NAMES[midi % 12] + str(midi // 12 - 1)
        peaks.append({"freq": round(fr, 1), "note": note,
                      "mag": round(float(mag[i] / mx), 3)})
    return peaks


# --------------------------------------------------------------------------
# Audio thread
# --------------------------------------------------------------------------
def audio_loop():
    sr = int(sd.query_devices(kind="input")["default_samplerate"])
    if CONFIG.get("samplerate"):
        sr = int(CONFIG["samplerate"])
    _stream["sr"] = sr

    def cb(indata, frames, tinfo, status):
        frame = analyze_block(indata[:, 0].astype(np.float64), sr)
        with _state_lock:
            _latest["frame"] = frame

    with sd.InputStream(channels=1, samplerate=sr, blocksize=BLOCK,
                        callback=cb, device=CONFIG.get("input_device")):
        while True:
            sd.sleep(1000)


def calibrate(seconds=2.0):
    """Measure room noise floor over `seconds` of (assumed) silence and save."""
    sr = _stream["sr"]
    rec = sd.rec(int(seconds * sr), samplerate=sr, channels=1,
                 device=CONFIG.get("input_device"))
    sd.wait()
    mono = rec[:, 0].astype(np.float64)
    noise = float(np.sqrt(np.mean(mono ** 2)))
    apply_calibration(CONFIG, noise)
    CONFIG["calibrated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    save_config(CONFIG)
    return {"noise_floor": CONFIG["noise_floor"], "rms_gate": CONFIG["rms_gate"],
            "calibrated_at": CONFIG["calibrated_at"]}


# --------------------------------------------------------------------------
# HTTP / SSE
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        if self.path == "/calibrate":
            result = calibrate()
            self._send(200, "application/json", json.dumps(result).encode())
        elif self.path.startswith("/target"):
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            if data.get("chord"):
                _target_chord["name"] = data["chord"]
            self._send(200, "application/json",
                       json.dumps({"target": _target_chord["name"]}).encode())
        else:
            self._send(404, "text/plain", b"not found")

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            with open("live_visualizer.html", "rb") as f:
                self._send(200, "text/html", f.read())
        elif self.path == "/config":
            self._send(200, "application/json", json.dumps(CONFIG).encode())
        elif self.path == "/stream":
            self._stream_sse()
        else:
            self._send(404, "text/plain", b"not found")

    def _stream_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                with _state_lock:
                    frame = _latest["frame"]
                if frame is not None:
                    payload = f"data: {json.dumps(frame)}\n\n".encode()
                    self.wfile.write(payload)
                    self.wfile.flush()
                time.sleep(0.05)   # ~20 fps
        except (BrokenPipeError, ConnectionResetError):
            pass


def main(port=8765):
    threading.Thread(target=audio_loop, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"ukejam live analyzer running at http://localhost:{port}")
    print(f"  mic: {sd.query_devices(kind='input')['name']} @ {_stream['sr']}Hz")
    print(f"  noise_floor={CONFIG['noise_floor']}  rms_gate={CONFIG['rms_gate']}")
    print("  Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
