// The lyric sheet under the Play view: each chord cue sits over the word it
// falls on, and clicking a cue jumps the target there.

import { escapeHtml } from "../../dom.ts";
import { currentChordIdx, currentSong, jumpToChord } from "../../session.ts";

let lyricsView: HTMLElement;
// per-global-chord-index lyric token elements + the line each belongs to,
// so currentChordIdx() -> {token, line} is O(1).
let lyricTokenEls: (HTMLElement | null)[] = [];
let lyricLineOfIdx: HTMLElement[] = [];

export function initLyrics(): void {
  lyricsView = document.getElementById("lyrics-view")!;
}

export function buildLyrics() {
  const song = currentSong();
  lyricsView.innerHTML = "";
  lyricTokenEls = [];
  lyricLineOfIdx = [];
  if (!song) {
    lyricsView.hidden = true;
    return;
  }
  lyricsView.hidden = false;

  let globalIdx = 0; // running index into chordSequence
  for (const line of song.lines) {
    if (line.section) {
      const sec = document.createElement("div");
      sec.className = "lyric-section";
      sec.textContent = line.section;
      lyricsView.appendChild(sec);
      continue;
    }
    if (!line.chords.length && !line.lyric.trim()) continue;

    const row = document.createElement("div");
    row.className = "lyric-line";

    if (!line.lyric.trim()) {
      // chord-only (intro/instrumental) line: render chords as bare cues
      row.classList.add("instrumental");
      line.chords.forEach((ch) => {
        const tok = document.createElement("span");
        tok.className = "lyric-tok bare";
        tok.innerHTML = `<span class="chord-cue">${escapeHtml(ch)}</span>`;
        const gi = globalIdx;
        tok.addEventListener("click", () => jumpToChord(gi));
        row.appendChild(tok);
        lyricTokenEls[gi] = tok;
        lyricLineOfIdx[gi] = row;
        globalIdx++;
      });
      lyricsView.appendChild(row);
      continue;
    }

    // lyric line: split into segments at each chord position, wrapping the
    // word starting at that position in a token that carries the cue above it.
    const lyric = line.lyric;
    // boundaries where a chord sits, sorted with their chord index
    const cuts = line.chords
      .map((ch, i) => ({ ch, i, pos: Math.min(line.chordPos[i] ?? 0, lyric.length) }))
      .sort((a, b) => a.pos - b.pos);

    let cursor = 0;
    for (let k = 0; k < cuts.length; k++) {
      const { ch, pos } = cuts[k];
      // plain text before this chord position
      if (pos > cursor) {
        row.appendChild(document.createTextNode(lyric.slice(cursor, pos)));
        cursor = pos;
      }
      // the word/run this chord cue sits over: up to the next chord cut, but
      // at least to the end of the current word (don't split mid-word visually)
      const nextPos = k + 1 < cuts.length ? cuts[k + 1].pos : lyric.length;
      let end = nextPos;
      // extend to the end of the current word so the underline glow hugs it
      const wordEnd = (() => {
        let e = pos;
        while (e < lyric.length && !/\s/.test(lyric[e])) e++;
        return e;
      })();
      if (wordEnd > end && wordEnd <= lyric.length) end = wordEnd;
      if (end <= cursor) end = Math.min(cursor + 1, lyric.length);

      const tok = document.createElement("span");
      tok.className = "lyric-tok";
      const wordText = lyric.slice(cursor, end) || "·";
      tok.innerHTML =
        `<span class="chord-cue">${escapeHtml(ch)}</span>` +
        `<span class="syll">${escapeHtml(wordText)}</span>`;
      const gi = globalIdx;
      tok.addEventListener("click", () => jumpToChord(gi));
      row.appendChild(tok);
      lyricTokenEls[gi] = tok;
      lyricLineOfIdx[gi] = row;
      globalIdx++;
      cursor = end;
    }
    // trailing text after the last chord
    if (cursor < lyric.length) {
      row.appendChild(document.createTextNode(lyric.slice(cursor)));
    }
    lyricsView.appendChild(row);
  }
  updateLyrics();
}

// Move highlight to the token at the current chord, brighten its line, autoscroll.
export function updateLyrics() {
  if (!currentSong()) return;
  const curLine = lyricLineOfIdx[currentChordIdx()];
  lyricTokenEls.forEach((tok, i) => {
    if (tok) tok.classList.toggle("lit", i === currentChordIdx());
  });
  lyricsView.querySelectorAll(".lyric-line").forEach((l) => {
    l.classList.toggle("now", l === curLine);
  });
  lyricTokenEls[currentChordIdx()]?.scrollIntoView({ block: "nearest" });
}
