// The beat grid: turning a song's tempo and bar markers into the timeline the
// transport, the highway and the bar scorer all read.
//
// Pure — no DOM, no app state. This is the arithmetic that decides which bar a
// beat belongs to, and therefore which bar a strum gets scored against; an
// off-by-one here files every verdict against the wrong chord.
//
// Pinned by verify-timing.mjs.

import type { Song } from "./song.ts";

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/// A song is timed when it carries a real tempo and has chords to place on the
/// grid. Untimed songs are play-to-advance: no transport, no rhythm scoring.
export function isTimedSong(song: Song): boolean {
  return song.tempo > 0 && song.chordSequence.length > 0;
}

/// Beats per bar, in quarter-note beats. A 6/8 bar is three quarter-beats.
export function beatsPerBarOf(song: Song): number {
  return (song.timeSig?.[0] ?? 4) * (4 / (song.timeSig?.[1] ?? 4));
}

export interface BeatTimeline {
  /// Beat position of each chord in chordSequence.
  chordBeat: number[];
  /// Total beats — the end of the last bar.
  songBeats: number;
}

/// Place every chord on the beat grid. With bar markers, each chord begins at a
/// new bar when barStart[i]; chords sharing a bar split it evenly. Without bar
/// info there is nothing better to assume than one beat per chord.
export function buildBeatTimeline(song: Song, beatsPerBar: number): BeatTimeline {
  const seq = song.chordSequence;
  const chordBeat: number[] = [];
  const hasBars = song.barStart.some(Boolean);
  let beat = 0;
  if (hasBars) {
    // group indices by bar (a new bar starts at barStart[i] or the first chord)
    for (let i = 0; i < seq.length; i++) {
      if (i === 0 || song.barStart[i]) {
        // count how many chords share this bar
        let n = 1;
        while (i + n < seq.length && !song.barStart[i + n]) n++;
        const per = beatsPerBar / n;
        for (let k = 0; k < n; k++) chordBeat[i + k] = beat + k * per;
        beat += beatsPerBar;
        i += n - 1;
      }
    }
  } else {
    // no bar info: one beat per chord
    for (let i = 0; i < seq.length; i++) chordBeat[i] = i;
    beat = seq.length;
  }
  return { chordBeat, songBeats: beat };
}

/// Bar ordinal for a beat position. Bars are uniform (beatsPerBar), which is how
/// buildBeatTimeline already lays out chordBeat.
export function barOfBeat(beat: number, beatsPerBar: number): number {
  return Math.floor(beat / beatsPerBar);
}
