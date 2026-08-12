// The chromagram: twelve height-driven bars, one per pitch class, with the
// target chord's tones marked.

import { PITCH_CLASSES } from "../../theory/chords.ts";

const chromaFills: HTMLElement[] = [];
const chromaBars: HTMLElement[] = [];

export function initChroma(): void {
  const chromaEl = document.getElementById("chroma")!;
  for (let i = 0; i < 12; i++) {
    const bar = document.createElement("div");
    bar.className = "chroma-bar";
    bar.innerHTML = `<div class="track"><div class="fill"></div></div><span class="pc">${PITCH_CLASSES[i]}</span>`;
    chromaEl.appendChild(bar);
    chromaBars.push(bar);
    chromaFills.push(bar.querySelector(".fill")!);
  }
}

/// Paint one frame of chroma. `values` is null when nothing is sounding, which
/// flattens the bars without losing the target marks.
export function drawChroma(values: number[] | null, targetPcs: number[]): void {
  for (let i = 0; i < 12; i++) {
    const v = values ? Math.max(0, Math.min(1, values[i] || 0)) : 0;
    chromaFills[i].style.height = values ? `${(4 + v * 92).toFixed(1)}%` : "4%";
    chromaBars[i].classList.toggle("target", targetPcs.includes(i));
  }
}
