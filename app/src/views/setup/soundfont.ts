// ---- SoundFont install/download ----
// Backing playback renders MIDI through a General MIDI SoundFont. None is
// bundled (the good banks aren't free to redistribute), so the Rust side
// resolves one from disk and returns the "no-soundfont" sentinel until the
// user installs one. This panel downloads a free SoundFont or explains how to
// supply your own.

import { nativeInvoke, onNative, type SoundfontProgress } from "../../native.ts";

interface SoundfontInfo {
  installed: boolean;
  path: string | null;
  data_dir: string;
}

export interface SoundfontDeps {
  /// Called after a successful install, so a song loaded before the SoundFont
  /// existed can be handed to the backing engine now that one does.
  onInstalled: () => void;
}

let deps: SoundfontDeps;
let overlayEl: HTMLElement;
let closeBtn: HTMLButtonElement;
let downloadBtn: HTMLButtonElement;
let progressEl: HTMLProgressElement;
let statusEl: HTMLElement;
let pathEl: HTMLElement;
let openFolderBtn: HTMLButtonElement;

let soundfontInstalled = false;

function showSoundfontPanel(): void {
  overlayEl.hidden = false;
}

function hideSoundfontPanel(): void {
  overlayEl.hidden = true;
}

// True if `e` was the missing-SoundFont sentinel (and the panel was shown), so
// callers can skip their own logging.
export function maybeSoundfontError(e: unknown): boolean {
  if (typeof e === "string" && e.includes("no-soundfont")) {
    showSoundfontPanel();
    return true;
  }
  return false;
}

export function playBacking(): void {
  if (!soundfontInstalled) {
    showSoundfontPanel();
    return;
  }
  nativeInvoke("play_backing").catch((e) => {
    if (!maybeSoundfontError(e)) console.warn("play_backing failed", e);
  });
}

/// Mobile has no user-facing file manager to open into the app's sandbox, so
/// the "show me the folder" button is desktop-only.
export function hideSoundfontOpenFolder(): void {
  openFolderBtn.hidden = true;
}

async function refreshSoundfontStatus(): Promise<void> {
  try {
    const info = await nativeInvoke<SoundfontInfo>("soundfont_status");
    soundfontInstalled = info.installed;
    if (info.data_dir) pathEl.textContent = info.data_dir;
  } catch {
    /* browser build (no native runtime): leave defaults */
  }
}

export function initSoundfont(d: SoundfontDeps): void {
  deps = d;
  overlayEl = document.getElementById("sf-overlay")!;
  closeBtn = document.getElementById("sf-close") as HTMLButtonElement;
  downloadBtn = document.getElementById("sf-download") as HTMLButtonElement;
  progressEl = document.getElementById("sf-progress") as HTMLProgressElement;
  statusEl = document.getElementById("sf-status")!;
  pathEl = document.getElementById("sf-path")!;
  openFolderBtn = document.getElementById("sf-open-folder") as HTMLButtonElement;

  void refreshSoundfontStatus();

  closeBtn.addEventListener("click", hideSoundfontPanel);
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) hideSoundfontPanel();
  });
  openFolderBtn.addEventListener("click", () => {
    nativeInvoke("open_data_dir").catch((e) => console.warn("open_data_dir failed", e));
  });

  onNative<SoundfontProgress>("soundfont_progress", ({ received, total }) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    if (total > 0) {
      progressEl.max = total;
      progressEl.value = received;
      statusEl.textContent = `${mb(received)} / ${mb(total)} MB`;
    } else {
      progressEl.removeAttribute("value"); // indeterminate
      statusEl.textContent = `${mb(received)} MB`;
    }
  });

  downloadBtn.addEventListener("click", async () => {
    downloadBtn.disabled = true;
    progressEl.hidden = false;
    progressEl.value = 0;
    statusEl.classList.remove("err");
    statusEl.textContent = "Starting…";
    try {
      await nativeInvoke<string>("download_soundfont");
      soundfontInstalled = true;
      await refreshSoundfontStatus();
      hideSoundfontPanel();
      // pick up the new SoundFont for the currently-loaded song, if any
      deps.onInstalled();
    } catch (e) {
      statusEl.classList.add("err");
      statusEl.textContent = typeof e === "string" ? e : "Download failed";
    } finally {
      downloadBtn.disabled = false;
      progressEl.hidden = true;
    }
  });
}
