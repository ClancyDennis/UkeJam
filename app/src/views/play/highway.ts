// The highway: the scrolling lane of upcoming chords above the NOW line, and
// the graded trail of bars behind it.
//
// When the song is timed, position comes from the wall-clock playhead
// (Rocksmith-style); otherwise it's a static lane of upcoming chords fanning up
// from the target.

import {
  LOOKAHEAD_BEATS,
  beatOfChord,
  currentChordIdx,
  currentSong,
  currentSongTime,
  isTimed,
  barBeats,
  secondsPerBeat,
  verdictBuffer,
} from "../../session.ts";
import { timingLabel, type BarVerdict } from "../../verdict.ts";
import { drawHand } from "../../strumcam.ts";
import { strumcam } from "../../strumcamShared.ts";

// How many bars the highway keeps tinted behind the NOW line.
const VERDICT_TRAIL_BARS = 3;

let highway: HTMLCanvasElement;
let hctx: CanvasRenderingContext2D;

export function initHighway(): void {
  highway = document.getElementById("highway") as HTMLCanvasElement;
  hctx = highway.getContext("2d")!;
}

/// The tracked hand, painted faintly behind everything else.
///
/// Declared decoration: it carries no information the arrows and the ghost count
/// don't already give, and it is drawn first so the chords always win the
/// foreground. What it buys is the felt sense that the app is watching — and, when
/// the tracker locks onto the wrong thing, a visible reason the arrows look wrong.
///
/// Alpha is deliberately low, and the skeleton is confined to the top-right
/// corner of the canvas — the one region the token lane never reaches (the lane
/// converges toward the top, and the trail hugs the center). Mapped full-frame,
/// a camera-centered hand landed exactly on the upcoming chords and read
/// straight through their translucent boxes.
function drawAmbientHand(w: number, h: number): void {
  const hand = strumcam.lastHand;
  if (!hand) return;
  // corner viewport: right ~30% of the width, top ~40% of the height
  const vw = w * 0.3;
  const vh = h * 0.4;
  hctx.save();
  hctx.globalAlpha = 0.16;
  hctx.translate(w - vw - 8, 8);
  drawHand(hctx, hand, vw, vh, {
    color: "rgba(25, 227, 196, 0.9)",
    jointColor: "rgba(25, 227, 196, 0.7)",
    lineWidth: 2,
  });
  hctx.restore();
}

export function drawHighway() {
  const song = currentSong();
  const dpr = window.devicePixelRatio || 1;
  const rect = highway.getBoundingClientRect();
  const w = rect.width || 360;
  const h = rect.height || 260;
  if (highway.width !== Math.round(w * dpr) || highway.height !== Math.round(h * dpr)) {
    highway.width = Math.round(w * dpr);
    highway.height = Math.round(h * dpr);
  }
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.clearRect(0, 0, w, h);
  drawAmbientHand(w, h);

  const cx = w / 2;
  const nowY = h - 64; // leaves room below the line for the verdict trail
  const topY = 28;
  const TEAL = "25,227,196";
  const GOLD = "245,196,81";
  // Verdict colours for the trail behind NOW. Green/amber/grey reads at a glance
  // without needing the legend a fourth colour would. These mirror
  // --verdict-hit/-wrong/-miss in styles.css, which tint the same bars on the
  // song strip; canvas needs the components separately for rgba(), hence the
  // duplication.
  const HIT = "76,222,128"; // --verdict-hit  #4cde80
  const WRONG = "245,158,66"; // --verdict-wrong #f59e42
  const MISS = "120,132,146"; // --verdict-miss  #788492

  if (!song) return;
  const seq = song.chordSequence;

  // perspective rails converging toward NOW
  hctx.strokeStyle = `rgba(${TEAL},0.12)`;
  hctx.lineWidth = 1;
  [[-1, 0.42, -1, 0.12], [1, 0.42, 1, 0.12]].forEach(([s, tb, , tt]) => {
    hctx.beginPath();
    hctx.moveTo(cx + (s as number) * w * (tt as number), topY);
    hctx.lineTo(cx + (s as number) * w * (tb as number), nowY);
    hctx.stroke();
  });

  // playhead beat (timed) or a synthetic position from the chord index (untimed)
  const headBeat = isTimed() ? currentSongTime() / secondsPerBeat() : (beatOfChord(currentChordIdx()) ?? currentChordIdx());

  // How far behind NOW the graded trail extends, in beats.
  const trailBeats = isTimed() ? VERDICT_TRAIL_BARS * barBeats() : VERDICT_TRAIL_BARS;

  // draw upcoming tokens from nearest-future back, mapping beat-distance to y.
  // Bars the playhead has already crossed stay on screen for a few beats, tinted
  // by their verdict — the player sees how the last bars went without looking
  // away from where they're going.
  for (let i = 0; i < seq.length; i++) {
    const tb = isTimed() ? beatOfChord(i) : i;
    const rel = tb - headBeat; // beats ahead of the playhead (0 = at NOW)
    if (rel > LOOKAHEAD_BEATS) break; // too far ahead
    const passed = rel < -0.6;
    const verdict = passed ? verdictBuffer().forChordIdx(i) : undefined;
    if (passed && (!verdict || rel < -trailBeats)) continue; // off the trail
    if (passed) {
      drawTrailToken(hctx, cx, nowY, verdict!, -rel / trailBeats, seq[i], { HIT, WRONG, MISS });
      continue;
    }
    const prog = Math.max(0, Math.min(1, rel / LOOKAHEAD_BEATS)); // 0 near .. 1 far
    const y = nowY - prog * (nowY - topY);
    const scale = 1 - prog * 0.55;
    const alpha = 1 - prog * 0.78;
    const isNow = rel < (isTimed() ? 0.5 : 0.5) && i === currentChordIdx();
    const col = isNow ? GOLD : TEAL;
    const tw = 60 * scale;
    const th = 30 * scale;
    roundRect(hctx, cx - tw / 2, y - th / 2, tw, th, 8 * scale);
    hctx.globalAlpha = alpha;
    // opaque backing first: the rails (and anything else behind the lane) must
    // not read through the token, the tint alone is nearly transparent
    hctx.fillStyle = "rgba(8, 13, 16, 0.92)";
    hctx.fill();
    hctx.strokeStyle = `rgba(${col},${isNow ? 0.95 : 0.55})`;
    hctx.lineWidth = 1.5 * scale;
    hctx.shadowColor = `rgba(${col},0.7)`;
    hctx.shadowBlur = isNow ? 14 : 6 * scale;
    hctx.stroke();
    hctx.fillStyle = `rgba(${col},0.06)`;
    hctx.fill();
    hctx.shadowBlur = 0;
    hctx.fillStyle = `rgba(${col},${isNow ? 1 : 0.9})`;
    hctx.font = `700 ${Math.round(22 * scale)}px "Chakra Petch", sans-serif`;
    hctx.textAlign = "center";
    hctx.textBaseline = "middle";
    hctx.fillText(seq[i], cx, y + 1);
    hctx.globalAlpha = 1;
  }

  // gold NOW line
  hctx.shadowColor = `rgba(${GOLD},0.8)`;
  hctx.shadowBlur = 14;
  hctx.strokeStyle = `rgba(${GOLD},0.95)`;
  hctx.lineWidth = 2;
  hctx.beginPath();
  hctx.moveTo(w * 0.12, nowY);
  hctx.lineTo(w * 0.88, nowY);
  hctx.stroke();
  hctx.shadowBlur = 0;
}

// A bar the playhead has passed, drawn below the NOW line and tinted by its
// verdict. `fade` runs 0 (just passed) -> 1 (leaving the trail); the token
// shrinks and dims as it goes so it never competes with what's coming.
//
// The timing arrow is the point of the whole onset detector: ▲ = you strummed
// early, ▼ = late. Only drawn past TIMING_TOLERANCE_MS, since below that the
// number is mostly detector latency rather than the player.
function drawTrailToken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  nowY: number,
  v: BarVerdict,
  fade: number,
  label: string,
  cols: { HIT: string; WRONG: string; MISS: string }
) {
  const f = Math.max(0, Math.min(1, fade));
  const col = v.status === "HIT" ? cols.HIT : v.status === "WRONG" ? cols.WRONG : cols.MISS;
  const y = nowY + 20 + f * 26;
  const scale = 0.72 - f * 0.22;
  const alpha = 0.85 * (1 - f);
  const tw = 56 * scale;
  const th = 26 * scale;
  ctx.globalAlpha = alpha;
  roundRect(ctx, cx - tw / 2, y - th / 2, tw, th, 7 * scale);
  // same opaque backing as the upcoming tokens: verdicts must stay readable
  // over whatever sits behind the trail
  ctx.fillStyle = "rgba(8, 13, 16, 0.92)";
  ctx.fill();
  ctx.strokeStyle = `rgba(${col},0.7)`;
  ctx.lineWidth = 1.2 * scale;
  ctx.stroke();
  ctx.fillStyle = `rgba(${col},0.1)`;
  ctx.fill();
  ctx.fillStyle = `rgba(${col},0.95)`;
  ctx.font = `700 ${Math.round(16 * scale)}px "Chakra Petch", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, y + 1);

  const timing = timingLabel(v.offsetMs);
  if (timing) {
    ctx.font = `700 ${Math.round(13 * scale)}px "Chakra Petch", sans-serif`;
    ctx.fillText(timing === "early" ? "▲" : "▼", cx + tw / 2 + 9 * scale, y + 1);
  }

  // Strum dots, left of the token: one per strum ACTUALLY PLAYED, filled when it
  // landed on the rhythmic grid (beat or half-beat) and hollow when it drifted.
  //
  // Deliberately not one dot per beat with the misses hollow: that would tell a
  // player strumming sensible half notes they missed two beats, when the app has no
  // idea what pattern the song wants (the Song model has no pattern field). And no
  // early/late marker, because on a half-beat grid "130ms late for the beat" and
  // "120ms early for the off-beat" are the same event. What can be shown honestly
  // is how many times you strummed and how many were in time.
  if (v.rhythm && v.rhythm.strums) {
    const r = v.rhythm;
    const shown = Math.min(r.strums, 8); // a very busy bar would otherwise sprawl
    const dot = 2.2 * scale;
    const step = dot * 2.8;
    const x0 = cx - tw / 2 - 10 * scale - (shown - 1) * step;
    for (let i = 0; i < shown; i++) {
      ctx.beginPath();
      ctx.arc(x0 + i * step, y + 1, dot, 0, Math.PI * 2);
      if (i < Math.min(r.onBeat, shown)) {
        ctx.fillStyle = `rgba(${col},0.9)`;
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(${col},0.45)`;
        ctx.lineWidth = 1 * scale;
        ctx.stroke();
      }
    }
    // Camera direction, above the dots. Present only when the camera was watching
    // this bar; `strokes` is null otherwise and nothing is drawn, rather than a row
    // of neutral marks implying the hand was measured and found still.
    //
    // Descriptive, NOT scored: direction accuracy hasn't been established against a
    // known-truth sequence yet, so this shows the player what was seen and nothing
    // grades against it.
    if (r.strokes && r.strokes.length) {
      const arrows = r.strokes.slice(0, shown);
      ctx.font = `700 ${Math.round(9 * scale)}px "Chakra Petch", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = `rgba(${col},0.75)`;
      for (let i = 0; i < arrows.length; i++) {
        ctx.fillText(arrows[i] === "down" ? "↓" : "↑", x0 + i * step, y - dot - 5 * scale);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
