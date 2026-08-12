// The note breakdown: the target chord's tones as present/missing tokens — the
// "where your fingers are wrong" visual — with any extras appended.

import { chordPitchClasses, pcNameToIndex, PITCH_CLASSES } from "../../theory/chords.ts";
import { currentTarget } from "../../session.ts";
import type { ChordReading } from "../../native.ts";

let targetNotesEl: HTMLElement;

export function initBreakdown(): void {
  targetNotesEl = document.getElementById("target-notes")!;
}

// Render the target chord-tones as present/missing tokens (the "where your
// fingers are wrong" visual). Pulls the target chord's pitch classes and marks
// each present unless the detector reports it missing; appends any extras.
export function renderBreakdown(reading: ChordReading | null) {
  if (!currentTarget()) {
    targetNotesEl.innerHTML = "";
    return;
  }
  const pcs = chordPitchClasses(currentTarget());
  const missingPcs = new Set((reading?.missing ?? []).map((n) => pcNameToIndex(n)));
  const active = !!reading?.active;
  let html = "";
  for (const pc of pcs) {
    const present = active && !missingPcs.has(pc);
    const cls = !active ? "" : present ? "present" : "missing";
    const mark = !active ? "" : present ? "✓" : "!";
    html += `<div class="note-tok ${cls}"><span>${PITCH_CLASSES[pc]}</span>${
      mark ? `<span class="mark">${mark}</span>` : ""
    }</div>`;
  }
  for (const ex of reading?.extra ?? []) {
    const pc = pcNameToIndex(ex);
    if (pc < 0 || pcs.includes(pc)) continue;
    html += `<div class="note-tok extra"><span>${PITCH_CLASSES[pc]}</span><span class="nm">extra</span><span class="mark">+</span></div>`;
  }
  targetNotesEl.innerHTML = html;
}
