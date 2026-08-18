// The Arrangement screen: the whole song as a chord sheet, with a card per
// unique chord showing its shape.
//
// Reads the current position from the session and follows it; the shape cards
// borrow the fretboard rail's SVG drawing rather than duplicating it.

import { escapeHtml, scrollWithin } from "../dom.ts";
import type { SongLine } from "../song.ts";
import { activeTuning } from "../tunings.ts";
import { chordShapeState, shapeLabel } from "../theory/voicings.ts";
import {
  currentChordIdx,
  currentRecord,
  currentSong,
  jumpToChord,
  nextDistinctChordInfo,
} from "../session.ts";
import { drawFretboard } from "./play/fretboard.ts";

export interface ArrangementDeps {
  /// Cycle a chord's shape. Spans this screen and the Play rail, so the
  /// orchestration lives above both.
  cycleChordShape: (name: string, delta: number) => void;
}

let deps: ArrangementDeps;

let arrangementView: HTMLElement;
let arrangementTagEl: HTMLElement;
let arrangementNowEl: HTMLElement;
let arrangementNextEl: HTMLElement;
let arrangementCountEl: HTMLElement;
let arrangementEmptyEl: HTMLElement;
let arrangementSheetEl: HTMLElement;
let arrangementChordsEl: HTMLElement;
let arrangementChordTagEl: HTMLElement;

// Element lists the screen rebuilds when a song loads, so currentChordIdx() ->
// {chord, line, card} stays O(1).
let arrangementChordEls: HTMLElement[] = [];
let arrangementLineOfIdx: HTMLElement[] = [];
let arrangementChordCards = new Map<string, HTMLElement>();
let lastArrangementScrollIdx = -1;

type ArrangementChord = {
  name: string;
  idx: number;
  firstInBar: boolean;
};

function arrangementBarsForLine(line: SongLine, startIdx: number): ArrangementChord[][] {
  const bars: ArrangementChord[][] = [];
  const hasBarMarkers = line.barStart.some(Boolean);
  line.chords.forEach((name, i) => {
    const startsBar = i === 0 || line.barStart[i] || (!hasBarMarkers && i > 0 && i % 4 === 0);
    if (startsBar || !bars.length) bars.push([]);
    bars[bars.length - 1].push({ name, idx: startIdx + i, firstInBar: startsBar });
  });
  return bars;
}

export function buildArrangement() {
  const song = currentSong();
  arrangementSheetEl.innerHTML = "";
  arrangementChordsEl.innerHTML = "";
  arrangementChordEls = [];
  arrangementLineOfIdx = [];
  arrangementChordCards = new Map();
  lastArrangementScrollIdx = -1;

  if (!song) {
    arrangementTagEl.textContent = "no song";
    arrangementChordTagEl.textContent = activeTuning().spelling;
    arrangementEmptyEl.hidden = false;
    arrangementSheetEl.hidden = true;
    updateArrangementState();
    return;
  }

  arrangementEmptyEl.hidden = true;
  arrangementSheetEl.hidden = false;
  const title = currentRecord()?.title || song.title || "Untitled";
  const artist = currentRecord()?.artist || song.artist;
  arrangementTagEl.textContent = artist ? `${title} · ${artist}` : title;
  arrangementChordTagEl.textContent = `${song.uniqueChords.length} shapes`;

  let globalIdx = 0;
  for (const line of song.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "arr-section";
      sec.textContent = line.section;
      arrangementSheetEl.appendChild(sec);
      continue;
    }

    const hasContent = line.chords.length || line.lyric.trim();
    if (!hasContent) continue;

    const row = document.createElement("div");
    row.className = "arr-line";
    if (!line.chords.length) row.classList.add("lyric-only");

    if (line.chords.length) {
      const chordRow = document.createElement("div");
      chordRow.className = "arr-chord-row";
      for (const bar of arrangementBarsForLine(line, globalIdx)) {
        const barEl = document.createElement("div");
        barEl.className = "arr-bar";
        for (const item of bar) {
          const chordEl = document.createElement("button");
          chordEl.className = "arr-chord";
          chordEl.type = "button";
          chordEl.textContent = item.name;
          chordEl.addEventListener("click", () => jumpToChord(item.idx));
          barEl.appendChild(chordEl);
          arrangementChordEls[item.idx] = chordEl;
          arrangementLineOfIdx[item.idx] = row;
        }
        chordRow.appendChild(barEl);
      }
      row.appendChild(chordRow);
    }

    const lyric = document.createElement("div");
    lyric.className = "arr-lyric";
    lyric.textContent = line.lyric.trim() || "instrumental";
    row.appendChild(lyric);
    arrangementSheetEl.appendChild(row);
    globalIdx += line.chords.length;
  }

  const counts = new Map<string, number>();
  song.chordSequence.forEach((ch) => counts.set(ch, (counts.get(ch) ?? 0) + 1));
  song.uniqueChords.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "arr-chord-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Jump to first ${ch}`);
    const state = chordShapeState(ch, activeTuning());
    card.innerHTML =
      `<span class="arr-card-head">` +
      `<span class="arr-card-name">${escapeHtml(ch)}</span>` +
      `<span class="arr-card-meta"><span class="arr-card-count">${counts.get(ch) ?? 0}x</span><span class="arr-card-shape">${state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1"}</span></span>` +
      `<span class="arr-card-actions">` +
      `<button class="arr-shape-btn arr-shape-prev" title="Previous fingering">&lsaquo;</button>` +
      `<button class="arr-shape-btn arr-shape-next" title="Next fingering">&rsaquo;</button>` +
      `</span>` +
      `</span>` +
      `<svg class="arr-mini-fret" viewBox="0 0 150 200" aria-label="${escapeHtml(ch)} fingering"></svg>`;
    const firstIdx = song!.chordSequence.indexOf(ch);
    card.addEventListener("click", () => jumpToChord(firstIdx));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      jumpToChord(firstIdx);
    });
    card.querySelector(".arr-shape-prev")?.addEventListener("click", (e) => {
      e.stopPropagation();
      deps.cycleChordShape(ch, -1);
    });
    card.querySelector(".arr-shape-next")?.addEventListener("click", (e) => {
      e.stopPropagation();
      deps.cycleChordShape(ch, 1);
    });
    arrangementChordsEl.appendChild(card);
    arrangementChordCards.set(ch, card);
    drawFretboard(
      ch,
      false,
      "Up Next",
      {
        svg: card.querySelector(".arr-mini-fret")!,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });

  redrawArrangementChordCards();
  updateArrangementState(true);
}

export function updateArrangementState(forceScroll = false) {
  const song = currentSong();
  const next = nextDistinctChordInfo();
  if (!song) {
    arrangementNowEl.textContent = "--";
    arrangementNextEl.textContent = "--";
    arrangementCountEl.textContent = "--";
    return;
  }

  const current = song.chordSequence[currentChordIdx()] ?? "--";
  arrangementNowEl.textContent = current;
  arrangementNextEl.textContent = next.name || "end";
  arrangementCountEl.textContent = `${currentChordIdx() + 1}/${song.chordSequence.length}`;

  arrangementChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < currentChordIdx());
    el.classList.toggle("now", i === currentChordIdx());
    el.classList.toggle("next", next.index >= 0 && i === next.index);
  });

  const curLine = arrangementLineOfIdx[currentChordIdx()];
  arrangementSheetEl.querySelectorAll(".arr-line").forEach((line) => {
    line.classList.toggle("now", line === curLine);
  });

  arrangementChordCards.forEach((card, name) => {
    card.classList.toggle("now", name === current);
    card.classList.toggle("next", !!next.name && name === next.name);
  });

  if ((forceScroll || lastArrangementScrollIdx !== currentChordIdx()) && curLine && !arrangementView.hidden) {
    // scroll only the sheet — scrollIntoView would also scroll its clipped
    // panel ancestors (see scrollWithin)
    scrollWithin(arrangementSheetEl, curLine as HTMLElement, "center");
    lastArrangementScrollIdx = currentChordIdx();
  }
}

export function redrawArrangementChordCards() {
  arrangementChordCards.forEach((card, name) => {
    const svg = card.querySelector(".arr-mini-fret");
    const shape = card.querySelector(".arr-card-shape");
    if (!svg || !shape) return;
    const state = chordShapeState(name, activeTuning());
    shape.textContent = state.count > 1 ? `shape ${shapeLabel(state)}` : "shape 1/1";
    card.querySelectorAll<HTMLButtonElement>(".arr-shape-btn").forEach((btn) => {
      btn.disabled = state.count <= 1;
    });
    drawFretboard(
      name,
      false,
      "Up Next",
      {
        svg,
        title: document.createElement("span"),
        tag: document.createElement("span"),
      },
      "__force__"
    );
  });
}

export function initArrangement(d: ArrangementDeps): void {
  deps = d;
  arrangementView = document.getElementById("arrangement-view")!;
  arrangementTagEl = document.getElementById("arrangement-tag")!;
  arrangementNowEl = document.getElementById("arr-now")!;
  arrangementNextEl = document.getElementById("arr-next")!;
  arrangementCountEl = document.getElementById("arr-count")!;
  arrangementEmptyEl = document.getElementById("arrangement-empty")!;
  arrangementSheetEl = document.getElementById("arrangement-sheet")!;
  arrangementChordsEl = document.getElementById("arrangement-chords")!;
  arrangementChordTagEl = document.getElementById("arrangement-chord-tag")!;
}

