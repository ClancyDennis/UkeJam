"""Persistent app settings — including mic calibration.

Mic calibration is needed repeatedly (room noise, mic, and levels change), so
it lives here as saved config rather than a one-off script. Stored as JSON next
to the app; the Tauri app will persist the same fields.
"""

import json
import os

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "ukejam_config.json")

DEFAULTS = {
    # --- audio device ---
    "input_device": None,      # None = system default; else sounddevice index
    "samplerate": None,        # None = use device default

    # --- mic calibration (the recurring setting) ---
    "noise_floor": 0.004,      # measured RMS of a silent room
    "rms_gate": 0.012,         # ignore frames quieter than this (auto = noise_floor * gate_ratio)
    "gate_ratio": 4.0,         # rms_gate = noise_floor * gate_ratio when auto-calibrated
    "ref_level": 0.15,         # measured RMS of a normal strum (for gain normalization)

    # --- detection tuning ---
    "fmin": 65.0,              # lowest freq considered (Hz)
    "fmax": 1050.0,            # highest freq considered (Hz); low enough to cut
                               # high harmonic bleed (e.g. F#'s 3rd harmonic = C#)
    "min_score": 0.7,          # min cosine match to report a chord
    "extra_note_tolerance": 1, # extra ringing notes allowed before "not clean"

    # --- bookkeeping ---
    "calibrated_at": None,     # ISO timestamp of last calibration (set by caller)
}


def load_config(path=CONFIG_PATH):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        try:
            with open(path) as f:
                cfg.update(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass  # corrupt/unreadable -> fall back to defaults
    return cfg


def save_config(cfg, path=CONFIG_PATH):
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    return path


def apply_calibration(cfg, noise_floor, ref_level=None):
    """Update config from a fresh measurement. Returns the modified cfg."""
    cfg["noise_floor"] = round(float(noise_floor), 6)
    cfg["rms_gate"] = round(float(noise_floor) * cfg["gate_ratio"], 6)
    if ref_level is not None:
        cfg["ref_level"] = round(float(ref_level), 6)
    return cfg


if __name__ == "__main__":
    cfg = load_config()
    print("Loaded config:")
    for k, v in cfg.items():
        print(f"  {k:22} {v}")
    print(f"\n(path: {CONFIG_PATH})")
