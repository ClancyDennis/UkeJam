// =====================================================================
// In-app tab search — find a chord sheet online (Rust scrapes Ultimate
// Guitar), preview it in an in-app WebKit window, and pull the text into
// the paste box so it flows through the normal ✨ enhance → Add pipeline.
// =====================================================================

import { aiProblemNote, describeAiFailure, invokeAiConfig, type AiProblem } from "../ai.ts";
import { nativeInvoke, onNative } from "../native.ts";
import { aiConfig, aiConfigReady, aiEnhanceProblem, onAiConfigChange } from "./setup/aiSettings.ts";

interface TabHit {
  artist: string;
  song: string;
  url: string;
  kind: string;
  rating: number;
  votes: number;
  version: number;
}
interface TabSearchOutcome {
  queries: string[];
  hits: TabHit[];
}
interface TabContent {
  title: string;
  artist: string;
  text: string;
  url: string;
}

export interface TabSearchDeps {
  /// Hand a fetched tab to the add-a-song form. Deliberately does NOT auto-add:
  /// the user reviews (and can ✨ enhance) it exactly like a manual paste.
  onTabLoaded: (tab: { title: string; artist: string; text: string }) => void;
}

let deps: TabSearchDeps;
let tabSearchInput: HTMLInputElement;
let tabSearchBtn: HTMLButtonElement;
let smartSearchToggle: HTMLInputElement;
let smartSearchHint: HTMLElement;
let tabResultsEl: HTMLElement;
let tabSearchStatus: HTMLElement;

let tabSearching = false;

function setTabSearchStatus(text: string, done = false) {
  tabSearchStatus.hidden = !text;
  tabSearchStatus.textContent = text;
  tabSearchStatus.classList.toggle("done", done);
}

async function runTabSearch() {
  const q = tabSearchInput.value.trim();
  if (!q || tabSearching) return;
  tabSearching = true;
  tabSearchBtn.disabled = true;
  tabResultsEl.hidden = true;
  tabResultsEl.replaceChildren();
  setTabSearchStatus(smartSearchToggle.checked ? "✨ working out what to search…" : "searching…");
  try {
    // smart mode goes through the configured AI provider — wait for the
    // durable settings so a saved key/model is actually used
    if (smartSearchToggle.checked) await aiConfigReady;
    // Rust degrades a failed interpretation to a plain search so smart mode is
    // never LESS capable than the plain one (see search_tabs in lib.rs). That
    // safety net is invisible from here, though: the player ticks ✨, gets
    // ordinary results, and believes the description was understood. So when
    // the provider is known to be unusable, skip the AI leg deliberately and
    // SAY the search ran plainly.
    const problem = smartSearchToggle.checked ? aiEnhanceProblem() : null;
    const smart = smartSearchToggle.checked && !problem;
    if (problem) renderSmartSearchHint();
    const out = await nativeInvoke<TabSearchOutcome>("search_tabs", {
      query: q,
      smart,
      config: smart ? invokeAiConfig(aiConfig) : null,
    });
    renderTabResults(q, out, { smartAsked: smartSearchToggle.checked, problem });
  } catch (e) {
    setTabSearchStatus(`search failed: ${describeAiFailure(e)}`);
  } finally {
    tabSearching = false;
    tabSearchBtn.disabled = false;
  }
}

/// Why ✨ smart can't run, shown beside the toggle so it is visible BEFORE a
/// search rather than only in the result line afterwards. Re-rendered whenever
/// the provider config changes.
function renderSmartSearchHint() {
  // Only while ✨ is actually ticked. An unconfigured provider is not a fault
  // to nag about on a screen whose plain search works perfectly well.
  const problem = smartSearchToggle.checked ? aiEnhanceProblem() : null;
  smartSearchHint.hidden = !problem;
  smartSearchHint.textContent = problem ? `✨ ${aiProblemNote(problem)}` : "";
}

function renderTabResults(
  rawQuery: string,
  out: TabSearchOutcome,
  smartState: { smartAsked: boolean; problem: AiProblem | null }
) {
  // when smart mode rewrote the query, show what was actually searched
  const rewrote = out.queries.length > 1 || out.queries[0] !== rawQuery;
  // ✨ was ticked but the words went out exactly as typed: either we skipped the
  // AI leg on purpose (problem) or Rust's fallback caught a failure we can't
  // see. Either way the player must not be left thinking it was interpreted.
  const skipped = smartState.smartAsked && !rewrote;
  const smartNote = !skipped
    ? ""
    : smartState.problem
      ? ` · ✨ skipped (${smartState.problem.message})`
      : " · ✨ couldn't interpret that — searched your words as typed";

  if (out.hits.length === 0) {
    setTabSearchStatus(`no chord tabs found — try adding the artist${smartNote}`);
    return;
  }
  const searched = rewrote ? ` · searched: ${out.queries.join(" / ")}` : "";
  setTabSearchStatus(`${out.hits.length} chord tabs${searched}${smartNote}`, true);

  for (const hit of out.hits) {
    const row = document.createElement("div");
    row.className = "tab-hit";
    row.title = "Load this tab into the paste box";

    const song = document.createElement("span");
    song.className = "t-song";
    song.textContent = hit.song;
    const artist = document.createElement("span");
    artist.className = "t-artist";
    artist.textContent = hit.artist;
    const meta = document.createElement("span");
    meta.className = "t-meta";
    const stars = hit.votes ? ` · ★${hit.rating.toFixed(1)} (${hit.votes})` : "";
    meta.textContent = `${hit.kind.toLowerCase()}${stars} · v${hit.version}`;
    const open = document.createElement("button");
    open.className = "t-open";
    open.textContent = "view ↗";
    open.title = "Open the tab page in an in-app preview window";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      nativeInvoke("open_tab_page", { url: hit.url }).catch((err) =>
        setTabSearchStatus(`couldn't open preview: ${err}`)
      );
    });

    row.append(song, artist, meta, open);
    row.addEventListener("click", () => useTabHit(hit));
    tabResultsEl.appendChild(row);
  }
  tabResultsEl.hidden = false;
}

// Pull a tab's text into the add-a-song form. Returns whether the fetch
// succeeded, so callers can react (the preview flow only closes its window on
// success).
async function loadTabFromUrl(
  url: string,
  fallback?: { song: string; artist: string }
): Promise<boolean> {
  setTabSearchStatus(`⇣ fetching ${fallback?.song ?? "tab"}…`);
  try {
    const tab = await nativeInvoke<TabContent>("fetch_tab", { url });
    deps.onTabLoaded({
      title: tab.title || fallback?.song || "",
      artist: tab.artist || fallback?.artist || "",
      text: tab.text,
    });
    const shown = tab.title || fallback?.song || "tab";
    setTabSearchStatus(`loaded "${shown}" — review below, then Add to library`, true);
    return true;
  } catch (e) {
    setTabSearchStatus(`couldn't fetch that tab: ${e}`);
    return false;
  }
}

function useTabHit(hit: TabHit) {
  void loadTabFromUrl(hit.url, hit);
}

export function initTabSearch(d: TabSearchDeps): void {
  deps = d;
  tabSearchInput = document.getElementById("tab-search-input") as HTMLInputElement;
  tabSearchBtn = document.getElementById("tab-search-btn") as HTMLButtonElement;
  smartSearchToggle = document.getElementById("smart-search") as HTMLInputElement;
  smartSearchHint = document.getElementById("smart-search-hint")!;
  tabResultsEl = document.getElementById("tab-results")!;
  tabSearchStatus = document.getElementById("tab-search-status")!;

  // The hint tracks Setup live: connecting OpenRouter on the next screen must
  // clear it without a reload.
  onAiConfigChange(renderSmartSearchHint);
  smartSearchToggle.addEventListener("change", renderSmartSearchHint);

  tabSearchBtn.addEventListener("click", runTabSearch);
  tabSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTabSearch();
  });

  // "⇣ use this tab" clicked inside the preview window (open_tab_page /
  // tab_preview_toolbar.js on the Rust side): fetch that page's tab into the
  // form, and only dismiss the preview once the text actually arrived.
  onNative<string>("tab_preview_extract", (url) => {
    void loadTabFromUrl(url).then((ok) => {
      if (ok) nativeInvoke("close_tab_preview").catch(() => {});
    });
  });
}
