// --- LLM coaching ---
// Everything the rest of the app does is local and instant. This part asks the
// model for the one thing it cannot compute: the pattern across bars. It fires
// on its own, so the guards below matter as much as the call — an eager coach
// that interrupts every few seconds is worse than no coach.

import { invokeAiConfig } from "../../ai.ts";
import { escapeHtml } from "../../dom.ts";
import { nativeInvoke, nativeRuntime } from "../../native.ts";
import { aiConfig } from "../setup/aiSettings.ts";
import { currentSong, isTimed, verdictBuffer } from "../../session.ts";
import type { BarVerdict } from "../../verdict.ts";

let coachTagEl: HTMLElement;
let coachAdviceEl: HTMLElement;

const COACH_WINDOW_BARS = 16; // how many graded bars the model sees
const COACH_MIN_BARS = 4; // below this there's no pattern to find
const COACH_COOLDOWN_MS = 20_000; // floor between calls, whatever triggered them
const COACH_ROUGH_WINDOW = 8; // bars the rough-patch check looks at
const COACH_ROUGH_RATE = 0.5; // hit rate below which the player is struggling
const COACH_SECTIONLESS_BARS = 16; // fallback cadence when a song has no sections

let coachInFlight = false;
let coachLastAt = 0;
let coachLastSection = "";
let coachBarsAtLastRequest = 0;
// Shown once per session, not per failure: a player without an endpoint
// configured would otherwise get the same error at every section boundary.
let coachEndpointWarned = false;

/// Ask for advice on the bars just played. Called from several triggers, all of
/// which can fire close together, so this is the single place the guards live.
export function requestCoaching(reason: string) {
  const song = currentSong();
  if (!nativeRuntime || !song || coachInFlight) return;
  if (verdictBuffer().length < COACH_MIN_BARS) return;
  const now = performance.now();
  if (coachLastAt && now - coachLastAt < COACH_COOLDOWN_MS) return;

  const window = verdictBuffer().recent(COACH_WINDOW_BARS);
  // Nothing sounded at all: the player is holding the instrument, not playing
  // it. Coaching silence produces advice about a performance that didn't happen.
  if (window.every((v) => v.status === "MISS")) return;

  const digest = verdictBuffer().digest(COACH_WINDOW_BARS, {
    tempo: isTimed() ? song.tempo : 0,
    timeSig: song.timeSig ?? [4, 4],
  });
  if (!digest) return;

  coachInFlight = true;
  coachLastAt = now;
  coachBarsAtLastRequest = verdictBuffer().length;
  renderCoachThinking(reason);
  // Same provider as tab enhancement — whatever is configured in Setup.
  nativeInvoke<string>("coach_bars", {
    digest,
    reason,
    config: invokeAiConfig(aiConfig),
  })
    .then((text) => renderCoachAdvice(text))
    .catch((e) => renderCoachError(e))
    .finally(() => {
      coachInFlight = false;
    });
}

/// Called after each bar is graded: the automatic triggers that depend on how
/// the playing is going, rather than on a transport event.
export function onBarSealed(v: BarVerdict) {
  if (!currentSong()) return;

  // Section boundary — the natural unit of "how did that bit go". Songs without
  // {comment:} markers get a fixed cadence instead.
  if (v.section) {
    if (coachLastSection && v.section !== coachLastSection) {
      requestCoaching(`finished the ${coachLastSection}`);
    }
    coachLastSection = v.section;
  } else if (verdictBuffer().length - coachBarsAtLastRequest >= COACH_SECTIONLESS_BARS) {
    requestCoaching(`${COACH_SECTIONLESS_BARS} bars in`);
  }

  // Rough patch — coaching arrives while the player is still in the trouble,
  // which is the only time it can actually help.
  const rate = verdictBuffer().hitRate(COACH_ROUGH_WINDOW);
  if (
    rate !== null &&
    rate < COACH_ROUGH_RATE &&
    verdictBuffer().length >= COACH_ROUGH_WINDOW
  ) {
    requestCoaching("struggling with this part");
  }
}

function renderCoachThinking(reason: string) {
  coachTagEl.textContent = reason;
  coachAdviceEl.innerHTML = `<span class="coach-thinking">thinking…</span>`;
}

/// Render the model's lines. Per SYSTEM_COACH it returns at most three short
/// sentences, fixes first and the encouraging one last, so the final line gets
/// the green rule. Anything longer is truncated rather than allowed to overflow
/// the panel — the prompt asks for three lines but can't be relied on for it.
function renderCoachAdvice(text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[-*•\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!lines.length) {
    coachAdviceEl.innerHTML = `<span class="coach-idle">Nothing to add — keep going.</span>`;
    return;
  }
  coachAdviceEl.innerHTML = lines
    .map((l, i) => {
      const good = lines.length > 1 && i === lines.length - 1;
      return `<div class="coach-line${good ? " good" : ""}">${escapeHtml(l)}</div>`;
    })
    .join("");
}

/// A failed coaching call must never interrupt practice. The most likely cause by
/// far is no configured provider, so say that once and then stay quiet.
function renderCoachError(e: unknown) {
  if (coachEndpointWarned) {
    coachAdviceEl.innerHTML = `<span class="coach-idle">Play a few bars and I'll tell you what to work on.</span>`;
    coachTagEl.textContent = "across bars";
    return;
  }
  coachEndpointWarned = true;
  console.warn("coaching unavailable", e);
  coachTagEl.textContent = "unavailable";
  coachAdviceEl.innerHTML =
    `<span class="coach-note">Coaching needs an AI provider — pick one on the Setup screen. ` +
    `Bar-by-bar scoring keeps working without it.</span>`;
}

/// Forget the advice on screen. Called on song load: advice about the previous
/// song is worse than none.
export function resetCoaching() {
  coachLastSection = "";
  coachBarsAtLastRequest = 0;
  coachTagEl.textContent = "across bars";
  coachAdviceEl.innerHTML =
    `<span class="coach-idle">Play a few bars and I'll tell you what to work on.</span>`;
}

/// Reset the bar counter that paces the sectionless fallback trigger. Called
/// when the score buffer is emptied, so it can't stay ahead of it.
export function resetCoachBarCount(): void {
  coachBarsAtLastRequest = 0;
}

export function initCoach(): void {
  coachTagEl = document.getElementById("coach-tag")!;
  coachAdviceEl = document.getElementById("coach-advice")!;
}
