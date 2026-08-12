// --- tuning (Setup screen) + mic calibration ---
// Tuning is persisted through Rust into app-data settings.json. `set_settings`
// merges, so writing `{tuning}` here cannot disturb the AI provider config that
// ai.ts owns.

import { nativeInvoke } from "../../native.ts";
import { setActiveTuning, activeTuning, type TuningId } from "../../tunings.ts";
import { beginCalibration, endCalibration, isCalibrating } from "../tuner.ts";

export interface TuningSetupDeps {
  /// The tuning changed: refresh everything derived from it — the tuner's
  /// string rows, cached voicings, fretboard diagrams, the arrangement sheet.
  onTuningChanged: () => void;
  /// Calibration ends with the mic stopped; clear the "live" indicator.
  markDisconnected: () => void;
}

let deps: TuningSetupDeps;
let taglineEl: HTMLElement;
let tuningChoiceEl: HTMLElement;
let tuningStatus: HTMLElement;
let calibrateBtn: HTMLButtonElement;
let setupStatus: HTMLElement;

// --- tuning (Setup screen) ---
// Persisted through Rust into app-data settings.json. `set_settings` merges, so
// writing `{tuning}` here cannot disturb the AI provider config that ai.ts owns.

/// Switch tuning and refresh everything derived from it: the tuner's target
/// strings (native + the row list), every cached voicing, and the labels. Safe
/// to call while listening — the native side swaps on the next window.
function applyTuning(id: TuningId, persist: boolean) {
  setActiveTuning(id);
  taglineEl.textContent = `${id === "baritone" ? "baritone" : "standard"} · ${activeTuning().spelling}`;
  tuningChoiceEl
    .querySelectorAll<HTMLInputElement>('input[name="tuning"]')
    .forEach((r) => (r.checked = r.value === id));

  deps.onTuningChanged();

  nativeInvoke("set_tuning", { tuning: id }).catch(() => {});
  if (!persist) return;
  nativeInvoke("set_settings", { settings: { tuning: id } })
    .then(() => {
      tuningStatus.classList.add("done");
      tuningStatus.textContent = `saved — tuning to ${activeTuning().spelling}`;
    })
    .catch((e) => {
      tuningStatus.classList.remove("done");
      tuningStatus.textContent = `save failed: ${e}`;
    });
}

// --- mic calibration (Setup screen) ---

async function runCalibration() {
  if (isCalibrating()) return;
  beginCalibration();
  calibrateBtn.disabled = true;
  setupStatus.classList.remove("done");
  setupStatus.textContent = "measuring… stay silent";
  try {
    await nativeInvoke("start_tuner"); // any capture mode emits rms
    await new Promise((r) => setTimeout(r, 2000));
    await nativeInvoke("stop_audio");
    // robust noise floor: 90th percentile of measured silence
    const calibSamples = endCalibration();
    let gate = 0.012;
    if (calibSamples.length) {
      const sorted = calibSamples.slice().sort((a, b) => a - b);
      const floor = sorted[Math.floor(sorted.length * 0.9)] || sorted[sorted.length - 1];
      gate = Math.max(0.006, floor * 4); // gate = noise floor x4
    }
    await nativeInvoke("set_gate", { gate });
    setupStatus.classList.add("done");
    setupStatus.textContent = `calibrated · gate ${gate.toFixed(4)} (this session)`;
  } catch (e) {
    setupStatus.textContent = `calibration error: ${e}`;
  } finally {
    // endCalibration() is idempotent: the success path already took the
    // samples, but an error thrown before it must not leave sampling on.
    endCalibration();
    calibrateBtn.disabled = false;
    deps.markDisconnected();
  }
}

export function initTuningSetup(d: TuningSetupDeps): void {
  deps = d;
  taglineEl = document.getElementById("tagline")!;
  tuningChoiceEl = document.getElementById("tuning-choice")!;
  tuningStatus = document.getElementById("tuning-status")!;
  calibrateBtn = document.getElementById("calibrate-btn") as HTMLButtonElement;
  setupStatus = document.getElementById("setup-status")!;

  tuningChoiceEl.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name !== "tuning") return;
    applyTuning(input.value === "baritone" ? "baritone" : "standard", true);
  });

  calibrateBtn.addEventListener("click", () => void runCalibration());

  // Rust applies the saved tuning to the tuner at startup; this aligns the UI
  // with it (and is a no-op re-send when the setting is absent/standard).
  void nativeInvoke<{ tuning?: string }>("get_settings")
    .then((s) => applyTuning(s?.tuning === "baritone" ? "baritone" : "standard", false))
    .catch(() => {});
}
