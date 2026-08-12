// The transport bars — one under Play, one under Arrangement, kept in step —
// and the backing-track mix picker.
//
// The session owns the clock; this is only its face. Everything here is either
// a button that asks the session to do something, or a readout the session
// pushes to through the callbacks initSession is given.

import { escapeHtml } from "../../dom.ts";
import { cameraActive, setCameraActive } from "../../strumcamShared.ts";
import { fmtTime } from "../../time.ts";
import {
  backingTrackList,
  isPlaying,
  restartTransport,
  selectedBackingChannels,
  setBackingChannels,
  startTransport,
  stopTransport,
  toggleWaitMode,
} from "../../session.ts";

export interface TransportDeps {
  /// Wait-mode or playback changed something the practice header shows.
  onPracticeStateChanged: () => void;
  /// The player asked to watch their hand and the camera wouldn't open.
  onCameraUnavailable: () => void;
}

let deps: TransportDeps;
let transportEl: HTMLElement;
let tpPlayBtn: HTMLButtonElement;
let tpRestartBtn: HTMLButtonElement;
let tpTimeEl: HTMLElement;
let tpBpmEl: HTMLElement;
let tpTracksBtn: HTMLButtonElement;
let tpWaitBtn: HTMLButtonElement;
let tpCamBtn: HTMLButtonElement;
let trackPickerEl: HTMLElement;
let backingControlsEl: HTMLElement;
let arrTransportEl: HTMLElement;
let arrPlayBtn: HTMLButtonElement;
let arrRestartBtn: HTMLButtonElement;
let arrTimeEl: HTMLElement;
let arrBpmEl: HTMLElement;

/// Play/pause flipped — both bars follow.
export function setPlayButtons(on: boolean): void {
  tpPlayBtn.textContent = on ? "❚❚" : "▶";
  tpPlayBtn.classList.toggle("on", on);
  arrPlayBtn.textContent = on ? "❚❚" : "▶";
  arrPlayBtn.classList.toggle("on", on);
}

/// The playhead moved.
export function setTimeReadout(sec: number): void {
  tpTimeEl.textContent = fmtTime(sec);
  arrTimeEl.textContent = fmtTime(sec);
}

/// A song's grid was rebuilt. An untimed song has no transport to show.
export function setTimingReadout(timed: boolean, tempo: number): void {
  transportEl.hidden = !timed;
  arrTransportEl.hidden = !timed;
  if (!timed) return;
  tpBpmEl.textContent = `${Math.round(tempo)} bpm`;
  arrBpmEl.textContent = `${Math.round(tempo)} bpm`;
}

/// Show the mix controls only when the song actually has backing audio.
export function setBackingControlsVisible(has: boolean): void {
  if (has) buildTrackPicker();
  backingControlsEl.hidden = !has;
}

function buildTrackPicker() {
  trackPickerEl.innerHTML = "";
  for (const t of backingTrackList()) {
    const on = selectedBackingChannels().includes(t.channel);
    const row = document.createElement("label");
    row.className = "track-opt";
    row.innerHTML =
      `<input type="checkbox" ${on ? "checked" : ""} /> ` +
      `<span>${escapeHtml(t.name)}</span>` +
      `<span class="t-meta">${t.isDrums ? "drums" : t.isBass ? "bass" : "ch" + (t.channel + 1)} · ${t.noteCount}</span>`;
    const cb = row.querySelector("input") as HTMLInputElement;
    cb.addEventListener("change", () => {
      const channels = selectedBackingChannels();
      // re-filter in place: keeps the current position + play state (no reload,
      // no resend of the file), so the song doesn't restart on a toggle.
      setBackingChannels(
        cb.checked
          ? channels.includes(t.channel) ? channels : [...channels, t.channel]
          : channels.filter((c) => c !== t.channel)
      );
    });
    trackPickerEl.appendChild(row);
  }
}

export function initTransport(d: TransportDeps): void {
  deps = d;
  transportEl = document.getElementById("transport")!;
  tpPlayBtn = document.getElementById("tp-play") as HTMLButtonElement;
  tpRestartBtn = document.getElementById("tp-restart") as HTMLButtonElement;
  tpTimeEl = document.getElementById("tp-time")!;
  tpBpmEl = document.getElementById("tp-bpm")!;
  tpTracksBtn = document.getElementById("tp-tracks") as HTMLButtonElement;
  tpWaitBtn = document.getElementById("tp-wait") as HTMLButtonElement;
  tpCamBtn = document.getElementById("tp-cam") as HTMLButtonElement;
  trackPickerEl = document.getElementById("track-picker")!;
  backingControlsEl = document.getElementById("backing-controls")!;
  arrTransportEl = document.getElementById("arr-transport")!;
  arrPlayBtn = document.getElementById("arr-play") as HTMLButtonElement;
  arrRestartBtn = document.getElementById("arr-restart") as HTMLButtonElement;
  arrTimeEl = document.getElementById("arr-time")!;
  arrBpmEl = document.getElementById("arr-bpm")!;

  tpPlayBtn.addEventListener("click", () => (isPlaying() ? stopTransport() : startTransport()));
  tpRestartBtn.addEventListener("click", restartTransport);
  arrPlayBtn.addEventListener("click", () => (isPlaying() ? stopTransport() : startTransport()));
  arrRestartBtn.addEventListener("click", restartTransport);

  tpWaitBtn.addEventListener("click", () => {
    tpWaitBtn.classList.toggle("on", toggleWaitMode());
    deps.onPracticeStateChanged();
  });

  tpTracksBtn.addEventListener("click", () => {
    trackPickerEl.hidden = !trackPickerEl.hidden;
  });

  // Reflect what the camera ENDED UP doing, not what we asked of it: a denied
  // permission prompt must leave the chip unlit rather than claiming to be watching.
  tpCamBtn.addEventListener("click", () => {
    const want = !cameraActive();
    tpCamBtn.disabled = true;
    void setCameraActive(want)
      .then((on) => {
        tpCamBtn.classList.toggle("on", on);
        // Asked for it and didn't get it — almost always a refused permission. Say so
        // where the player is looking, or the chip just silently fails to light.
        if (want && !on) deps.onCameraUnavailable();
      })
      .finally(() => (tpCamBtn.disabled = false));
  });
}

