// The chord-diagram rail: the two fretboard panels ("Now" and "Up Next"), the
// transition coach between them, and the SVG drawing itself.
//
// Redraws are gated on the chord actually changing (lastCurrentFretChord and
// friends) because this runs from the render loop — rebuilding the SVG every
// frame would be pure waste.

import { escapeHtml } from "../../dom.ts";
import { activeTuning } from "../../tunings.ts";
import { chordShapeState, shapeLabel, voicingKey } from "../../theory/voicings.ts";
import {
  currentChordIdx,
  currentSong,
  currentTarget,
  isTimed,
  nextDistinctChordInfo,
} from "../../session.ts";

let currentFretboardEl: HTMLElement;
let currentFingerTagEl: HTMLElement;
let currentFingerTitleEl: HTMLElement;
let currentFingerPanelEl: HTMLElement;
let currentShapeControlsEl: HTMLElement;
let currentShapeCountEl: HTMLElement;
let currentShapePrevBtn: HTMLButtonElement;
let currentShapeNextBtn: HTMLButtonElement;
let fretboardEl: HTMLElement;
let fingerTagEl: HTMLElement;
let fingerTitleEl: HTMLElement;
let nextFingerPanelEl: HTMLElement;
let nextShapeControlsEl: HTMLElement;
let nextShapeCountEl: HTMLElement;
let nextShapePrevBtn: HTMLButtonElement;
let nextShapeNextBtn: HTMLButtonElement;
let transitionTagEl: HTMLElement;
let transitionCoachEl: HTMLElement;

/// The chord name the detector last reported. Set by paintFretboards each
/// frame, so the panels and the shape buttons agree on which diagram is on
/// show even in free play, where there is no target.
let lastDetected = "";

export interface FretboardDeps {
  /// Cycle to another shape of `name`. Spans two views (this rail and the
  /// arrangement cards), so the orchestration lives in the caller.
  cycleChordShape: (name: string, delta: number) => void;
  /// Is the chord detector running? Dims the "Now" panel when it isn't.
  isChordListening: () => boolean;
}

let deps: FretboardDeps;





export function shapeTag(name: string, state: { index: number; count: number }, extra = ""): string {
  if (!name) return activeTuning().spelling;
  const shape = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
  return `${name}${extra} · ${shape}`;
}

export function setShapeControls(
  name: string,
  controls: HTMLElement,
  countEl: HTMLElement,
  prevBtn: HTMLButtonElement,
  nextBtn: HTMLButtonElement
) {
  const state = chordShapeState(name, activeTuning());
  const canCycle = state.count > 1;
  controls.hidden = !canCycle;
  countEl.textContent = shapeLabel(state);
  prevBtn.disabled = !canCycle;
  nextBtn.disabled = !canCycle;
}

export function invalidateFretboards() {
  lastCurrentFretChord = "__none__";
  lastNextFretChord = "__none__";
  lastTransitionKey = "__none__";
}

// Draw baritone chord diagrams. The right rail shows two shapes at once:
// current target ("Now") and the next distinct shape ("Up Next").
let lastCurrentFretChord = "__none__";
let lastNextFretChord = "__none__";
let lastTransitionKey = "__none__";

export function currentFretboardChord(detected: string, matched: boolean): { name: string; played: boolean } {
  return { name: currentTarget() || detected, played: matched };
}

export function nextFretboardChord(): { name: string; played: boolean; isNext: boolean } {
  if (currentSong() && currentTarget()) {
    const next = nextDistinctChordInfo();
    if (next.name) {
      return { name: next.name, played: false, isNext: true };
    }
    return { name: "", played: false, isNext: false };
  }
  return { name: "", played: false, isNext: true };
}

function formatBeatDistance(beats: number): string {
  if (!Number.isFinite(beats)) return "";
  if (beats < 0.1) return "now";
  if (beats < 1) return "under 1 beat";
  return `${beats.toFixed(beats < 3 ? 1 : 0)} beats`;
}

export function updateFretboardPanelState(matched: boolean) {
  const next = nextDistinctChordInfo();
  const currentName = currentFretboardChord(lastDetected, matched).name;
  const nextGlow = next.name ? Math.max(0.12, Math.min(1, next.urgency)) : 0;
  currentFingerPanelEl.classList.toggle("is-clean", matched);
  nextFingerPanelEl.classList.toggle("has-upcoming", !!next.name);
  nextFingerPanelEl.classList.toggle("is-close", nextGlow > 0.68);
  currentFingerPanelEl.style.setProperty("--now-glow", currentSong() ? "1" : deps.isChordListening() ? "0.62" : "0.35");
  nextFingerPanelEl.style.setProperty("--next-glow", nextGlow.toFixed(2));
  setShapeControls(currentName, currentShapeControlsEl, currentShapeCountEl, currentShapePrevBtn, currentShapeNextBtn);
  setShapeControls(next.name, nextShapeControlsEl, nextShapeCountEl, nextShapePrevBtn, nextShapeNextBtn);
  if (next.name) {
    const eta = isTimed() ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
    fingerTagEl.textContent = shapeTag(next.name, chordShapeState(next.name, activeTuning()), eta);
  }
  updateTransitionCoach();
}

function fretChip(fret: number | null): string {
  if (fret === null) return "x";
  return fret === 0 ? "0" : String(fret);
}

function fretHint(fret: number | null): string {
  if (fret === null) return "mute";
  return fret === 0 ? "open" : `fret ${fret}`;
}

export function updateTransitionCoach(force = false) {
  const nowName = currentFretboardChord(lastDetected, false).name;
  const next = nextDistinctChordInfo();
  const nextName = next.name;
  const nowState = chordShapeState(nowName, activeTuning());
  const nextState = chordShapeState(nextName, activeTuning());
  const eta = isTimed() && nextName ? ` · ${formatBeatDistance(next.beatsUntil)}` : "";
  const key = `${nowName}|${nowState.index}|${nextName}|${nextState.index}|${currentChordIdx()}|${eta}`;
  if (!force && key === lastTransitionKey) return;
  lastTransitionKey = key;

  if (!nowName || !nextName || !nowState.voicing || !nextState.voicing) {
    transitionTagEl.textContent = currentSong() ? "last chord" : "free play";
    transitionCoachEl.innerHTML = currentSong()
      ? `<div class="transition-empty">Stay on ${escapeHtml(nowName || "the chord")}.</div>`
      : `<div class="transition-empty">Load a song to see the next move.</div>`;
    return;
  }

  transitionTagEl.textContent = `${nowName} -> ${nextName}${eta}`;
  const actions = activeTuning().stringLabels.map((label, i) => {
    const from = nowState.voicing![i];
    const to = nextState.voicing![i];
    let kind = "move";
    let hint = `to ${fretHint(to)}`;
    if (from === to) {
      kind = "anchor";
      hint = from === null ? "muted" : "hold";
    } else if (to === null) {
      kind = "lift";
      hint = "mute";
    } else if (from === null) {
      kind = "add";
      hint = `add ${fretHint(to)}`;
    }
    return { label, from, to, kind, hint };
  });

  const anchors = actions.filter((a) => a.kind === "anchor" && a.to !== null).length;
  const changes = actions.filter((a) => a.kind !== "anchor").length;
  const headline = changes
    ? `${changes} move${changes === 1 ? "" : "s"} · ${anchors} anchor${anchors === 1 ? "" : "s"}`
    : "same shape";
  const rows = actions
    .map(
      (a) => `
        <div class="transition-string ${a.kind}">
          <span class="transition-string-name">${escapeHtml(a.label)}</span>
          <span class="transition-fret from">${fretChip(a.from)}</span>
          <span class="transition-arrow">&rarr;</span>
          <span class="transition-fret to">${fretChip(a.to)}</span>
          <span class="transition-hint">${escapeHtml(a.hint)}</span>
        </div>`
    )
    .join("");

  transitionCoachEl.innerHTML = `
    <div class="transition-summary">${escapeHtml(headline)}</div>
    <div class="transition-strings">${rows}</div>`;
}

export function drawFretboard(
  name: string,
  played: boolean,
  label: "Now" | "Up Next",
  els: { svg: Element; title: Element; tag: Element },
  lastKey: string
): string {
  const state = chordShapeState(name, activeTuning());
  const key = `${label}|${name}|${played}|${state.index}|${state.count}|${state.voicing ? voicingKey(state.voicing) : "none"}`;
  if (key === lastKey) return lastKey;

  // verified shape first; fall back to a generated one for chords not in the
  // hand-checked table (so MIDI-derived exotics still get a diagram)
  const voicing = state.voicing;
  const accent = played ? "#19e3c4" : "#f5c451";
  const glow = played ? "rgba(25,227,196,0.6)" : "rgba(245,196,81,0.5)";
  const dim = "#2b4440";

  // geometry: 4 strings (cols), 4 frets (rows)
  const nS = 4,
    nF = 4;
  const x0 = 28,
    y0 = 40,
    w = 94,
    h = 120;
  const dx = w / (nS - 1);
  const dy = h / nF;

  els.title.textContent = label;
  if (!voicing) {
    els.svg.innerHTML = `<text x="75" y="105" fill="${dim}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">no diagram</text>`;
    els.tag.textContent = name ? `${name} · ${activeTuning().spelling}` : activeTuning().spelling;
    return key;
  }
  els.tag.textContent = shapeTag(name, state);

  // If the shape sits high on the neck, show a window of nF frets starting at
  // baseFret (with a position label) instead of always frets 0–4 from the nut.
  const fretted = voicing.filter((f): f is number => f !== null && f > 0);
  const maxFret = fretted.length ? Math.max(...fretted) : 0;
  const baseFret = maxFret > nF ? Math.max(...fretted, 1) - (nF - 1) : 1;
  const openNut = baseFret === 1; // draw a thick nut only in open position

  const parts: string[] = [];
  // nut (thick at open position) or position label
  if (openNut) {
    parts.push(`<rect x="${x0 - 1}" y="${y0 - 4}" width="${w + 2}" height="4" fill="${dim}"/>`);
  } else {
    parts.push(`<text x="${x0 - 12}" y="${y0 + dy / 2 + 4}" fill="${accent}" font-size="11" font-family="JetBrains Mono, monospace" text-anchor="middle">${baseFret}</text>`);
  }
  // fret lines
  for (let f = 0; f <= nF; f++) {
    const y = y0 + f * dy;
    parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${dim}" stroke-width="1"/>`);
  }
  // strings + labels + markers
  for (let s = 0; s < nS; s++) {
    const x = x0 + s * dx;
    parts.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + h}" stroke="${dim}" stroke-width="1.2"/>`);
    parts.push(`<text x="${x}" y="${y0 + h + 18}" fill="${dim}" font-size="11" font-family="Chakra Petch, sans-serif" text-anchor="middle">${activeTuning().stringLabels[s]}</text>`);

    const fret = voicing[s];
    if (fret === null) {
      parts.push(`<text x="${x}" y="${y0 - 8}" fill="${accent}" font-size="12" font-family="JetBrains Mono, monospace" text-anchor="middle">×</text>`);
    } else if (fret === 0) {
      parts.push(`<circle cx="${x}" cy="${y0 - 12}" r="4.5" fill="none" stroke="${accent}" stroke-width="1.6"/>`);
    } else {
      const rel = fret - baseFret + 1; // 1-based row within the visible window
      const y = y0 + (rel - 0.5) * dy;
      parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${accent}" style="filter:drop-shadow(0 0 6px ${glow})"/>`);
    }
  }
  els.svg.innerHTML = parts.join("");
  return key;
}

/// Repaint both diagram panels for the current detection. Returns nothing —
/// the redraw guards are this module's business, not the render loop's.
export function paintFretboards(detected: string, matched: boolean): void {
  lastDetected = detected;
  const nowFb = currentFretboardChord(detected, matched);
  const nextFb = nextFretboardChord();
  lastCurrentFretChord = drawFretboard(
    nowFb.name,
    nowFb.played,
    "Now",
    { svg: currentFretboardEl, title: currentFingerTitleEl, tag: currentFingerTagEl },
    lastCurrentFretChord
  );
  lastNextFretChord = drawFretboard(
    nextFb.name,
    nextFb.played,
    "Up Next",
    { svg: fretboardEl, title: fingerTitleEl, tag: fingerTagEl },
    lastNextFretChord
  );
}

export function initFretboard(d: FretboardDeps): void {
  deps = d;
  currentFretboardEl = document.getElementById("current-fretboard")!;
  currentFingerTagEl = document.getElementById("current-finger-tag")!;
  currentFingerTitleEl = document.getElementById("current-finger-title")!;
  currentFingerPanelEl = document.querySelector<HTMLElement>(".current-finger-panel")!;
  currentShapeControlsEl = document.getElementById("current-shape-controls")!;
  currentShapeCountEl = document.getElementById("current-shape-count")!;
  currentShapePrevBtn = document.getElementById("current-shape-prev") as HTMLButtonElement;
  currentShapeNextBtn = document.getElementById("current-shape-next") as HTMLButtonElement;
  fretboardEl = document.getElementById("fretboard")!;
  fingerTagEl = document.getElementById("finger-tag")!;
  fingerTitleEl = document.getElementById("finger-title")!;
  nextFingerPanelEl = document.querySelector<HTMLElement>(".next-finger-panel")!;
  nextShapeControlsEl = document.getElementById("next-shape-controls")!;
  nextShapeCountEl = document.getElementById("next-shape-count")!;
  nextShapePrevBtn = document.getElementById("next-shape-prev") as HTMLButtonElement;
  nextShapeNextBtn = document.getElementById("next-shape-next") as HTMLButtonElement;
  transitionTagEl = document.getElementById("transition-tag")!;
  transitionCoachEl = document.getElementById("transition-coach")!;

  currentShapePrevBtn.addEventListener("click", () => {
    deps.cycleChordShape(currentFretboardChord(lastDetected, false).name, -1);
  });
  currentShapeNextBtn.addEventListener("click", () => {
    deps.cycleChordShape(currentFretboardChord(lastDetected, false).name, 1);
  });
  nextShapePrevBtn.addEventListener("click", () => {
    deps.cycleChordShape(nextFretboardChord().name, -1);
  });
  nextShapeNextBtn.addEventListener("click", () => {
    deps.cycleChordShape(nextFretboardChord().name, 1);
  });
}

