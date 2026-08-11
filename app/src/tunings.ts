// --- instrument tuning ---
// Two ukuleles are supported: the standard G-C-E-A most instruments ship with
// (soprano/concert/tenor) and the baritone D-G-B-E. The choice drives the tuner
// strings, the chord-diagram open strings, and every fret label; it is
// persisted in settings.json and mirrored to Rust via `set_tuning`.
//
// `strings` is in playing order (4th string first), NOT pitch order — standard
// tuning is re-entrant, so its 4th string G4 sounds above the 3rd string C4.
// `openPc` is the pitch class of each open string, used by the voicing search.
export type TuningId = "standard" | "baritone";

export interface TuningSpec {
  id: TuningId;
  label: string;
  /// Short form for the header tagline and diagram tags, e.g. "G C E A".
  spelling: string;
  strings: { note: string; hz: number }[];
  openPc: number[];
  stringLabels: string[];
}

export const TUNINGS: Record<TuningId, TuningSpec> = {
  standard: {
    id: "standard",
    label: "Standard (soprano · concert · tenor)",
    spelling: "G C E A",
    strings: [
      { note: "G4", hz: 392.0 },
      { note: "C4", hz: 261.63 },
      { note: "E4", hz: 329.63 },
      { note: "A4", hz: 440.0 },
    ],
    openPc: [7, 0, 4, 9],
    stringLabels: ["G", "C", "E", "A"],
  },
  baritone: {
    id: "baritone",
    label: "Baritone",
    spelling: "D G B E",
    strings: [
      { note: "D3", hz: 146.83 },
      { note: "G3", hz: 196.0 },
      { note: "B3", hz: 246.94 },
      { note: "E4", hz: 329.63 },
    ],
    openPc: [2, 7, 11, 4],
    stringLabels: ["D", "G", "B", "E"],
  },
};

// The tuning in force. Standard is the default: it's what most ukuleles are.
// Replaced by the saved setting during startup (see applyTuning in
// views/setup/tuningSetup.ts), before the user can play anything.
let active: TuningSpec = TUNINGS.standard;

export function activeTuning(): TuningSpec {
  return active;
}

export function setActiveTuning(id: TuningId): TuningSpec {
  active = TUNINGS[id];
  return active;
}
