// =====================================================================
// In-app tab search — find a chord sheet online (Rust scrapes Ultimate
// Guitar), preview it in an in-app WebKit window, and pull the text into
// the paste box so it flows through the normal ✨ enhance → Add pipeline.
// =====================================================================

import { invokeAiConfig } from "../ai.ts";
import { nativeInvoke } from "../native.ts";
import { aiConfig, aiConfigReady } from "./setup/aiSettings.ts";

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
    const out = await nativeInvoke<TabSearchOutcome>("search_tabs", {
      query: q,
      smart: smartSearchToggle.checked,
      config: smartSearchToggle.checked ? invokeAiConfig(aiConfig) : null,
    });
    renderTabResults(q, out);
  } catch (e) {
    setTabSearchStatus(`search failed: ${e}`);
  } finally {
    tabSearching = false;
    tabSearchBtn.disabled = false;
  }
}

function renderTabResults(rawQuery: string, out: TabSearchOutcome) {
  if (out.hits.length === 0) {
    setTabSearchStatus("no chord tabs found — try adding the artist, or ✨ smart");
    return;
  }
  // when smart mode rewrote the query, show what was actually searched
  const rewrote = out.queries.length > 1 || out.queries[0] !== rawQuery;
  const searched = rewrote ? ` · searched: ${out.queries.join(" / ")}` : "";
  setTabSearchStatus(`${out.hits.length} chord tabs${searched}`, true);

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

// Pull a chosen tab's text into the add-a-song form.
async function useTabHit(hit: TabHit) {
  setTabSearchStatus(`⇣ fetching ${hit.song}…`);
  try {
    const tab = await nativeInvoke<TabContent>("fetch_tab", { url: hit.url });
    deps.onTabLoaded({
      title: tab.title || hit.song,
      artist: tab.artist || hit.artist,
      text: tab.text,
    });
    setTabSearchStatus(`loaded "${tab.title || hit.song}" — review below, then Add to library`, true);
  } catch (e) {
    setTabSearchStatus(`couldn't fetch that tab: ${e}`);
  }
}

export function initTabSearch(d: TabSearchDeps): void {
  deps = d;
  tabSearchInput = document.getElementById("tab-search-input") as HTMLInputElement;
  tabSearchBtn = document.getElementById("tab-search-btn") as HTMLButtonElement;
  smartSearchToggle = document.getElementById("smart-search") as HTMLInputElement;
  tabResultsEl = document.getElementById("tab-results")!;
  tabSearchStatus = document.getElementById("tab-search-status")!;

  tabSearchBtn.addEventListener("click", runTabSearch);
  tabSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTabSearch();
  });
}
