// The note breakdown: the target chord's tones as present/missing tokens — the
// "where your fingers are wrong" visual — with any extras appended.

import { chordPitchClasses, pcNameToIndex, PITCH_CLASSES } from "../../theory/chords.ts";
import { currentTarget } from "../../session.ts";
import type { ChordReading } from "../../native.ts";

/// Above this many extra pitch classes, list them as a count rather than one by
/// one. A ukulele has four strings, so a real fingering mistake adds one or two
/// notes; four is already generous. Beyond that the cause is broadband sound
/// (whistling, a voice, a fan) rather than fingers, and the individual names carry
/// no action.
export const EXTRA_ITEMISE_LIMIT = 4;

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
  // Extras, capped. Past the cap the itemised list stops being feedback: a
  // whistle, a voice or a fan lights most of the twelve pitch classes at once, and
  // "extra C#, D, D#, F, G, G#, A#, B — try muting" asks the player to mute eight
  // notes they never played. Naming a few is diagnosis; naming most of the octave
  // means the mic isn't hearing a chord at all, and saying THAT is the useful thing.
  const extras: number[] = [];
  for (const ex of reading?.extra ?? []) {
    const pc = pcNameToIndex(ex);
    if (pc < 0 || pcs.includes(pc)) continue;
    extras.push(pc);
  }
  if (extras.length > EXTRA_ITEMISE_LIMIT) {
    // One token instead of a row of them, so the layout can't be blown apart by
    // noise and the reading is legible on a phone.
    html +=
      `<div class="note-tok extra noisy" title="${extras.length} pitch classes outside the chord are sounding">` +
      `<span>${extras.length} extra</span><span class="nm">noisy</span></div>`;
  } else {
    for (const pc of extras) {
      html += `<div class="note-tok extra"><span>${PITCH_CLASSES[pc]}</span><span class="nm">extra</span><span class="mark">+</span></div>`;
    }
  }
  targetNotesEl.innerHTML = html;
}
