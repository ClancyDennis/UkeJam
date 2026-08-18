// --- LLM coaching ---
// Everything the rest of the app does is local and instant. This part asks the
// model for the one thing it cannot compute: the pattern across bars. It fires
// on its own, so the guards below matter as much as the call — an eager coach
// that interrupts every few seconds is worse than no coach.

import { aiProblemNote, describeAiFailure, invokeAiConfig, type AiProblem } from "../../ai.ts";
import { escapeHtml } from "../../dom.ts";
import { nativeInvoke, nativeRuntime } from "../../native.ts";
import { aiConfig, aiConfigReady, aiEnhanceProblem } from "../setup/aiSettings.ts";
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
// The last reason coaching couldn't run, so the explanation is written once per
// distinct cause rather than at every section boundary. Keyed by TEXT, not a
// boolean: a player who fixes a missing key and then hits an unreachable
// endpoint deserves to hear the second reason too, which a one-shot latch
// swallowed.
let coachLastProblemNote = "";

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

  // Claim the slot and the cooldown SYNCHRONOUSLY. Everything below is async,
  // and several triggers can fire within one bar — the guards have to be set
  // before the first await or two calls go out for the same bars.
  coachInFlight = true;
  coachLastAt = now;
  coachBarsAtLastRequest = verdictBuffer().length;
  renderCoachThinking(reason);
  void sendCoachingRequest(digest, reason);
}

async function sendCoachingRequest(digest: string, reason: string) {
  try {
    // The provider config is read from the durable native store asynchronously
    // at boot, and coaching can fire within seconds of a song loading. Without
    // this the first request of a session goes out with the localStorage seed —
    // which on iOS may have been evicted, so a player WITH a configured key
    // gets told coaching needs a provider, once, for the whole session.
    await aiConfigReady;
    // A provider that can't run costs nothing to detect, so detect it instead
    // of spending a round trip to be told. This is the same gate the library's
    // ✨ enhance and tab search's ✨ smart use.
    const problem = aiEnhanceProblem();
    if (problem) {
      renderCoachProblem(problem);
      return;
    }
    // Same provider as tab enhancement — whatever is configured in Setup.
    const text = await nativeInvoke<string>("coach_bars", {
      digest,
      reason,
      config: invokeAiConfig(aiConfig),
    });
    coachLastProblemNote = "";
    renderCoachAdvice(text);
  } catch (e) {
    renderCoachError(e);
  } finally {
    coachInFlight = false;
  }
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

/// Coaching can't run and we know why before asking. Says so once per distinct
/// cause, and always says what still works — the panel going quiet mid-practice
/// otherwise reads as the app breaking.
function renderCoachProblem(problem: AiProblem) {
  // The note can quote a base URL the player typed, so it is escaped like any
  // other user text before it reaches innerHTML.
  const note = aiProblemNote(problem);
  renderCoachUnavailable(note, `${escapeHtml(note)}. Bar-by-bar scoring keeps working without it.`);
}

/// A failed coaching call must never interrupt practice. Unlike the pre-check
/// above this is the endpoint's own words (a 401, an unreachable host, a model
/// id it doesn't have), which is exactly what the player needs to fix it.
function renderCoachError(e: unknown) {
  const detail = describeAiFailure(e);
  console.warn("coaching unavailable", e);
  renderCoachUnavailable(
    detail,
    `Coaching couldn't reach the AI provider (${escapeHtml(detail)}) — check ⚙ Setup. ` +
      `Bar-by-bar scoring keeps working without it.`
  );
}

/// The shared body. Repeating the same explanation at every section boundary is
/// nagging, but replacing it with the idle line ("Play a few bars and I'll tell
/// you what to work on") promises coaching that is never coming — so a repeat
/// keeps a short standing note instead of either.
function renderCoachUnavailable(cause: string, html: string) {
  coachTagEl.textContent = "unavailable";
  if (cause === coachLastProblemNote) {
    coachAdviceEl.innerHTML = `<span class="coach-note">Coaching is off — see ⚙ Setup. Scoring continues.</span>`;
    return;
  }
  coachLastProblemNote = cause;
  coachAdviceEl.innerHTML = `<span class="coach-note">${html}</span>`;
}

/// Forget the advice on screen. Called on song load: advice about the previous
/// song is worse than none.
export function resetCoaching() {
  coachLastSection = "";
  coachBarsAtLastRequest = 0;
  // A new song is a fresh chance to explain: the player may have visited Setup
  // between songs, and if the same problem is still there it is re-reported
  // once rather than never.
  coachLastProblemNote = "";
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
