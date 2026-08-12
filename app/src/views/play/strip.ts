// The chord strip under the Play view: one chip per chord in the song, tinted
// by its verdict.
//
// The verdict tint persists for the whole run, so the strip doubles as a map of
// where the song went wrong — the highway trail only shows the last few bars.

import { currentChordIdx, currentSong, jumpToChord, verdictBuffer } from "../../session.ts";

let songStrip: HTMLElement;
let songBarEmpty: HTMLElement;
let stripChordEls: HTMLElement[] = [];

export function initStrip(): void {
  songStrip = document.getElementById("song-strip")!;
  songBarEmpty = document.getElementById("song-bar-empty")!;
}

export function buildSongStrip() {
  const song = currentSong();
  songStrip.innerHTML = "";
  stripChordEls = [];
  if (!song) return;
  songBarEmpty.hidden = true;
  songStrip.hidden = false;
  const hasBars = song.barStart.some(Boolean);
  song.chordSequence.forEach((ch, i) => {
    // bar separator before any chord (except the first) that starts a measure
    if (hasBars && i > 0 && song!.barStart[i]) {
      const sep = document.createElement("span");
      sep.className = "bar-sep";
      songStrip.appendChild(sep);
    }
    const el = document.createElement("span");
    el.className = "strip-chord";
    el.textContent = ch;
    el.addEventListener("click", () => {
      jumpToChord(stripChordEls.indexOf(el));
    });
    songStrip.appendChild(el);
    stripChordEls.push(el);
  });
  updateStrip();
}

export function updateStrip() {
  stripChordEls.forEach((el, i) => {
    el.classList.toggle("done", i < currentChordIdx());
    el.classList.toggle("current", i === currentChordIdx());
    // Verdict tint persists for the whole run, so the strip doubles as a map of
    // where the song went wrong — the highway trail only shows the last few bars.
    const v = verdictBuffer().forChordIdx(i);
    el.classList.toggle("hit", v?.status === "HIT");
    el.classList.toggle("wrong", v?.status === "WRONG");
    el.classList.toggle("miss", v?.status === "MISS");
  });
  // keep the current chord in view
  stripChordEls[currentChordIdx()]?.scrollIntoView({ block: "nearest", inline: "center" });
}
