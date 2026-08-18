// Checks what the app does when the AI provider is unconfigured, unreachable,
// or simply not available on this host.
//
// Every other verify script pins a computation. This one pins a DEGRADATION
// CONTRACT, because that is where this feature's bugs live: nothing about AI
// enhance is load-bearing — a tab saves fine un-enhanced, a search runs fine
// without the query interpreter, and bar scoring is entirely local — so a
// broken provider path never crashes anything. It just quietly does less than
// the player thinks it is doing, and nothing on screen says so.
//
// The three failures this exists to prevent, all of which shipped:
//
//   1. Silent degradation. Rust's search_tabs falls back to a plain search when
//      the query interpreter fails (lib.rs). Correct — but the frontend showed
//      ordinary results with no note, so ticking ✨ smart with no API key was
//      indistinguishable from ✨ smart working.
//   2. A doomed round trip in place of a check. The provider config is known
//      locally; asking an endpoint to tell us there is no API key costs a
//      network timeout and returns an error the player has to decode.
//   3. Advice pointing somewhere that cannot help. "open ⚙ Setup" is right for
//      a missing key and wrong for a browser preview with no Tauri bridge —
//      there is nothing in Setup to change.
//
// Two halves, in the shape verify-calltrim.mjs established: unit checks against
// the real exported logic, then a scan of the shipped view sources asserting
// they still route through it. The scan is the half that matters — the pure
// helpers can be perfect while a view calls invoke() straight past them.
//
// Run with `pnpm verify:ai`. Plain node, no dependencies.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ai.ts touches localStorage at call time (not module scope), so a stub has to
// exist before the first loadAiConfig()/saveAiConfig(). `window` stays absent,
// which is exactly the browser-preview case: the module's `native` flag is
// false and no Tauri import is ever reached.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  AI_NEEDS_NATIVE_APP,
  AI_PROVIDERS,
  aiConfigProblem,
  aiHostProblem,
  aiProblem,
  aiProblemNote,
  appleAvailabilityHint,
  describeAiFailure,
  hydrateAiConfig,
  invokeAiConfig,
  isLocalEndpoint,
  loadAiConfig,
  saveAiConfig,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
} = await import("./ai.ts");

let failures = 0;
function ok(label, cond, detail = "") {
  if (cond) {
    console.log(`ok   ${label}`);
    return;
  }
  failures++;
  console.error(`FAIL ${label}${detail ? `  — ${detail}` : ""}`);
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(name) {
  console.log(`\n${name}`);
}

const cfg = (over = {}) => ({ provider: "openrouter", baseUrl: "", apiKey: "", model: "", ...over });
const AVAILABLE = "available";

// =====================================================================
section("loadAiConfig() — a store that is empty, partial, or corrupt");
// =====================================================================
// The seed is read before anything can validate it, so every shape localStorage
// can be in has to produce a usable config rather than throw during boot.
{
  store.clear();
  const fresh = loadAiConfig();
  eq("a fresh install defaults to OpenRouter", fresh.provider, "openrouter");
  eq("…with its default model filled in", fresh.model, AI_PROVIDERS.openrouter.defaultModel);
  eq("…and no key", fresh.apiKey, "");

  store.set("ukejam.ai.v1", "{not json");
  ok("corrupt JSON falls back to defaults rather than throwing", loadAiConfig().provider === "openrouter");

  store.set("ukejam.ai.v1", JSON.stringify({ provider: "gemini", apiKey: 42, model: null }));
  const junk = loadAiConfig();
  eq("an unknown provider id is replaced, not trusted", junk.provider, "openrouter");
  eq("a non-string key becomes an empty string", junk.apiKey, "");
  eq("a null model takes the provider default", junk.model, AI_PROVIDERS.openrouter.defaultModel);

  store.set("ukejam.ai.v1", JSON.stringify({ provider: "openai", baseUrl: "http://x/v1" }));
  eq("a valid saved provider survives", loadAiConfig().provider, "openai");

  store.clear();
}
{
  // Storage that is present but denied (private mode, quota) must not take the
  // app down on a path that only wanted to persist a preference.
  const good = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
    removeItem() {},
  };
  let threw = false;
  try {
    loadAiConfig();
    await saveAiConfig(cfg());
  } catch {
    threw = true;
  }
  globalThis.localStorage = good;
  ok("a throwing localStorage breaks neither load nor save", !threw);
}
{
  const config = cfg({ apiKey: "sk-live" });
  const loaded = await hydrateAiConfig(config);
  ok("hydrate is a no-op without a native runtime", loaded === false);
  eq("…and leaves the seeded config untouched", config.apiKey, "sk-live");
}

// =====================================================================
section("aiConfigProblem() — apple");
// =====================================================================
// Every status the plugin's availability enum can report must produce a REASON,
// never a bare "unavailable" — an unexplained disabled provider reads as a bug
// in the app rather than a setting on the device.
{
  eq(
    "available is the only status with no problem",
    aiConfigProblem(cfg({ provider: "apple" }), AVAILABLE),
    null
  );

  // The list the Rust side documents (tauri-plugin-local-llm/src/models.rs).
  const here = dirname(fileURLToPath(import.meta.url));
  const modelsRs = readFileSync(
    join(here, "..", "tauri-plugin-local-llm", "src", "models.rs"),
    "utf8"
  );
  // Only the doc comment on AvailabilityResponse — the rest of the file
  // backticks unrelated identifiers, and sweeping them all in made this check
  // fail on `system` from a comment about chat roles.
  const enumDoc = modelsRs
    .slice(0, modelsRs.indexOf("pub struct AvailabilityResponse"))
    .split(/\n\s*\n/)
    .pop();
  const documented = [...enumDoc.matchAll(/`([a-zA-Z]+)`/g)]
    .map((m) => m[1])
    .filter((name) => name !== "available" && name !== "unavailable");
  ok(
    "the Rust availability enum was found to check against",
    documented.length >= 5,
    `parsed ${JSON.stringify(documented)}`
  );
  for (const status of documented) {
    const hint = appleAvailabilityHint(status);
    ok(`'${status}' has its own player-facing hint`, hint !== "unavailable", `got "${hint}"`);
    const problem = aiConfigProblem(cfg({ provider: "apple" }), status);
    ok(`'${status}' blocks enhance and names the reason`, Boolean(problem) && problem.includes(hint));
  }
  eq(
    "an unrecognised status still blocks, with a generic hint",
    aiConfigProblem(cfg({ provider: "apple" }), "somethingNew"),
    "Apple Intelligence is unavailable (unavailable)"
  );
  eq(
    "the boot default (before the probe answers) blocks",
    aiConfigProblem(cfg({ provider: "apple" }), "unsupportedHost"),
    "Apple Intelligence is unavailable (Apple devices only)"
  );
}

// =====================================================================
section("aiConfigProblem() — openrouter");
// =====================================================================
{
  eq("no key is a problem", aiConfigProblem(cfg(), AVAILABLE), "OpenRouter needs an API key");
  eq(
    "whitespace is not a key",
    aiConfigProblem(cfg({ apiKey: "   " }), AVAILABLE),
    "OpenRouter needs an API key"
  );
  eq("a key clears it", aiConfigProblem(cfg({ apiKey: "sk-or-v1-x" }), AVAILABLE), null);
  eq(
    "a blank model is NOT a problem — the endpoint is fixed and its default is real",
    aiConfigProblem(cfg({ apiKey: "sk-or-v1-x", model: "" }), AVAILABLE),
    null
  );
  eq(
    "…and that default is what actually gets sent",
    invokeAiConfig(cfg({ apiKey: "k", model: "" })).model,
    AI_PROVIDERS.openrouter.defaultModel
  );
}

// =====================================================================
section("aiConfigProblem() — a custom OpenAI-compatible endpoint");
// =====================================================================
// The awkward provider: both the key and the model are legitimately optional
// depending on what is at the other end, so neither can simply be required.
{
  const openai = (over) => cfg({ provider: "openai", model: "gpt-4.1-mini", ...over });

  eq(
    "a keyless PUBLIC endpoint is flagged — it can only answer 401",
    aiConfigProblem(openai({ baseUrl: OPENAI_BASE_URL }), AVAILABLE),
    "api.openai.com needs an API key"
  );
  eq(
    "…naming the host the player typed, not a generic 'API key required'",
    aiConfigProblem(openai({ baseUrl: "https://litellm.example.com/v1" }), AVAILABLE),
    "litellm.example.com needs an API key"
  );
  eq(
    "an empty base URL means the OpenAI default, so it needs a key too",
    aiConfigProblem(openai({ baseUrl: "" }), AVAILABLE),
    "api.openai.com needs an API key"
  );
  eq(
    "a key clears it",
    aiConfigProblem(openai({ baseUrl: OPENAI_BASE_URL, apiKey: "sk-x" }), AVAILABLE),
    null
  );

  // Keyless local servers are the reason the key can't just be required.
  for (const base of [
    "http://localhost:1234/v1",
    "localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:1234/v1",
    "http://192.168.1.40:1234/v1",
    "http://10.0.0.5:1234/v1",
    "http://172.16.4.4:1234/v1",
    "http://studio.local:1234/v1",
  ]) {
    eq(`keyless is fine for ${base}`, aiConfigProblem(openai({ baseUrl: base }), AVAILABLE), null);
    ok(`isLocalEndpoint("${base}")`, isLocalEndpoint(base));
  }
  for (const base of [
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "http://172.32.0.1/v1", // just outside the private range
    "http://11.0.0.1/v1",
    "http://notlocalhost.example.com/v1",
    "",
    "   ",
  ]) {
    ok(`isLocalEndpoint("${base}") is false`, !isLocalEndpoint(base));
  }

  eq(
    "an unparseable address is reported instead of being posted to",
    aiConfigProblem(openai({ baseUrl: "http://", apiKey: "k" }), AVAILABLE),
    '"http://" isn\'t a usable endpoint address'
  );

  // A cleared Model field. There is no safe default here: gpt-4.1-mini is a
  // guess about SOMEONE ELSE'S endpoint, and its 404 reads as a broken app.
  eq(
    "a blank model IS a problem for a custom endpoint",
    aiConfigProblem(openai({ baseUrl: "http://localhost:1234/v1", model: "" }), AVAILABLE),
    "no model selected"
  );
  eq(
    "…and nothing is guessed into the payload",
    invokeAiConfig(openai({ baseUrl: "http://localhost:1234/v1", model: "" })).model,
    ""
  );
  eq(
    "whitespace is not a model",
    aiConfigProblem(openai({ baseUrl: "http://localhost:1234/v1", model: "  " }), AVAILABLE),
    "no model selected"
  );
}

// =====================================================================
section("invokeAiConfig() — what actually crosses the bridge");
// =====================================================================
{
  eq(
    "openrouter's endpoint is fixed, whatever is saved in baseUrl",
    invokeAiConfig(cfg({ baseUrl: "http://evil.example", apiKey: "k" })).baseUrl,
    OPENROUTER_BASE_URL
  );
  eq(
    "apple sends no endpoint at all",
    invokeAiConfig(cfg({ provider: "apple", baseUrl: "http://x" })).baseUrl,
    ""
  );
  eq(
    "a blank custom base falls back to OpenAI's",
    invokeAiConfig(cfg({ provider: "openai", model: "m" })).baseUrl,
    OPENAI_BASE_URL
  );
  eq("keys are trimmed", invokeAiConfig(cfg({ apiKey: "  k  " })).apiKey, "k");
  eq("models are trimmed", invokeAiConfig(cfg({ apiKey: "k", model: "  m  " })).model, "m");
}

// =====================================================================
section("aiProblem() / aiProblemNote() — host before configuration");
// =====================================================================
// The ordering is the point. With no native bridge there is nothing in Setup to
// change, so pointing the player at Setup is worse than useless.
{
  const unconfigured = cfg();
  const configured = cfg({ apiKey: "sk-or-v1-x" });

  eq("host problem wins over a config problem", aiProblem(unconfigured, AVAILABLE, false).message, AI_NEEDS_NATIVE_APP);
  eq(
    "…and a perfectly configured provider is still blocked by the host",
    aiProblem(configured, AVAILABLE, false).message,
    AI_NEEDS_NATIVE_APP
  );
  ok("a host problem is not fixable in Setup", aiProblem(configured, AVAILABLE, false).fixable === false);
  ok("a config problem is", aiProblem(unconfigured, AVAILABLE, true).fixable === true);
  eq("a working setup has no problem at all", aiProblem(configured, AVAILABLE, true), null);
  eq("aiHostProblem is null with a runtime", aiHostProblem(true), null);

  eq(
    "the note points a fixable problem at Setup",
    aiProblemNote({ message: "OpenRouter needs an API key", fixable: true }),
    "OpenRouter needs an API key — open ⚙ Setup"
  );
  eq(
    "the note does NOT point an unfixable one there",
    aiProblemNote({ message: AI_NEEDS_NATIVE_APP, fixable: false }),
    AI_NEEDS_NATIVE_APP
  );
  ok(
    "the host message names the real remedy (installing the app), not Setup",
    !AI_NEEDS_NATIVE_APP.includes("Setup")
  );
}

// =====================================================================
section("describeAiFailure() — what the player is shown when a call fails");
// =====================================================================
{
  eq(
    "the bridge's internal sentinel is translated, not shown",
    describeAiFailure("native runtime unavailable"),
    AI_NEEDS_NATIVE_APP
  );
  eq(
    "…including when it's wrapped in an Error",
    describeAiFailure(new Error("native runtime unavailable")),
    AI_NEEDS_NATIVE_APP
  );
  // The endpoint's own words are the most useful thing there is here — a 401
  // body says whether the key or the model id was wrong. Keep them verbatim.
  const real = "endpoint returned 401 Unauthorized: invalid api key";
  eq("an endpoint's own message survives intact", describeAiFailure(real), real);
  eq("Error instances are unwrapped to their message", describeAiFailure(new Error(real)), real);

  const flood = "x".repeat(5000);
  const described = describeAiFailure(flood);
  ok("a runaway error body is truncated, not pasted into the status line", described.length <= 200);
  ok("…and says it was cut", described.endsWith("…"));

  eq("an empty rejection still says something", describeAiFailure(""), "the provider failed without saying why");
  eq("so does undefined", describeAiFailure(undefined), "the provider failed without saying why");
  eq("so does null", describeAiFailure(null), "the provider failed without saying why");
}

// =====================================================================
section("the shipped views still route through the gate");
// =====================================================================
// The half that has teeth. Every check above tests a pure function that a view
// is free to ignore — and the bug this suite exists for was exactly that: the
// helpers were right, the caller invoked past them.
//
// Scanned with comments stripped, because this file's own reasoning (and the
// views') necessarily quotes the shapes being checked for.
{
  const here = dirname(fileURLToPath(import.meta.url));

  function sources(dir) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sources(p));
      else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const files = new Map(sources(here).map((p) => [p, stripComments(readFileSync(p, "utf8"))]));
  ok("the scan found source files", files.size > 10, `found ${files.size}`);

  // Which files send an AI request, found by what they invoke rather than by a
  // hardcoded path — so moving the code can't silently outrun this guard.
  const AI_COMMANDS = ["enhance_tab", "coach_bars", "search_tabs", "test_ai", "ai_models"];
  const callers = [...files]
    .filter(([, src]) => AI_COMMANDS.some((cmd) => src.includes(`"${cmd}"`)))
    .map(([p]) => p);
  ok(
    "every AI command has a caller the guard can see",
    AI_COMMANDS.every((cmd) => [...files.values()].some((src) => src.includes(`"${cmd}"`))),
    `callers: ${callers.map((p) => p.split("/").pop()).join(", ")}`
  );

  // A function's body by brace matching. Needed because the sources are scanned
  // with comments stripped, so there is no doc-comment delimiter left to slice on.
  function body(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) return "";
    let i = src.indexOf("{", start);
    if (i < 0) return "";
    for (let depth = 0; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    return "";
  }

  const named = (suffix) => [...files].find(([p]) => p.endsWith(suffix));
  const need = (suffix) => {
    const hit = named(suffix);
    if (!hit) {
      failures++;
      console.error(`FAIL ${suffix} not found — the guard is pointing at a file that moved`);
      return "";
    }
    return hit[1];
  };

  const coach = need("views/play/coach.ts");
  const library = need("views/libraryView.ts");
  const tabSearch = need("views/tabSearch.ts");
  const settings = need("views/setup/aiSettings.ts");

  // 1. Nothing sends a request before the durable store has been read. The seed
  //    is localStorage, which iOS evicts under disk pressure — an enhance fired
  //    on the seed can be unauthenticated while a key sits in settings.json.
  for (const [label, src] of [
    ["the coach", coach],
    ["the library's enhance", library],
    ["tab search's smart mode", tabSearch],
  ]) {
    ok(`${label} waits for aiConfigReady before sending`, src.includes("await aiConfigReady"));
  }

  // 2. Nothing spends a round trip to be told what is knowable locally.
  for (const [label, src] of [
    ["the coach", coach],
    ["the library's enhance", library],
    ["tab search's smart mode", tabSearch],
    ["Setup's Test connection", settings],
  ]) {
    ok(`${label} checks the provider before invoking`, src.includes("aiEnhanceProblem()"));
  }

  // 3. The Setup pointer is composed in one place, so it can never be attached
  //    to a problem Setup cannot fix.
  for (const [label, src] of [
    ["the coach", coach],
    ["the library", library],
    ["tab search", tabSearch],
  ]) {
    ok(`${label} builds its advice with aiProblemNote()`, src.includes("aiProblemNote("));
    ok(
      `${label} does not hand-roll the "open ⚙ Setup" pointer`,
      !/open ⚙ Setup/.test(src),
      "found a literal Setup pointer outside aiProblemNote()"
    );
  }

  // 4. A rejected invoke is never rendered raw: the bridge's internal
  //    "native runtime unavailable" is not a sentence for a player.
  for (const [label, src] of [
    ["the coach", coach],
    ["the library", library],
    ["tab search", tabSearch],
    ["Setup", settings],
  ]) {
    ok(`${label} renders failures through describeAiFailure()`, src.includes("describeAiFailure("));
  }

  // 5. A failed enhance still saves the song, and a failed search still runs.
  //    Both are the whole reason AI is optional here.
  ok(
    "a failed enhance saves the un-enhanced text rather than nothing",
    /catch[\s\S]{0,200}saved raw/.test(library) && /catch[\s\S]{0,220}saved chart only/.test(library)
  );
  ok(
    "the add path never returns early on an AI problem",
    !/aiProblem[\s\S]{0,120}\breturn\b/.test(library),
    "an AI problem must skip the enhance step, not abandon the save"
  );

  // 6. ✨ smart never degrades in silence. Rust falls back to a plain search on
  //    any interpreter failure; if the frontend doesn't say so, the player
  //    reads plain results as smart ones.
  ok("smart search reports when the AI leg was skipped", /✨ skipped/.test(tabSearch));
  ok(
    "…and when Rust's own fallback swallowed a failure",
    /couldn't interpret/.test(tabSearch),
    "no note covers the case where smart ran but returned the query unchanged"
  );
  ok(
    "smart mode sends no config when it isn't running",
    /config:\s*smart\s*\?/.test(tabSearch),
    "an API key should not travel with a search that isn't using it"
  );

  // 7. The coach must not replace a failure with the idle line. "Play a few
  //    bars and I'll tell you what to work on" after a failure promises
  //    coaching that is never coming.
  // Only the failure renderers: the idle line is legitimate elsewhere —
  // resetCoaching writes it on song load, where nothing has failed.
  const coachFailurePaths = ["renderCoachProblem", "renderCoachError", "renderCoachUnavailable"]
    .map((fn) => body(coach, fn))
    .join("\n");
  ok(
    "the guard found the coach's failure renderers",
    coachFailurePaths.length > 200,
    `extracted ${coachFailurePaths.length} chars — a renamed function would empty this`
  );
  ok(
    "the extractor CAN see the idle line where it belongs (so this has teeth)",
    body(coach, "resetCoaching").includes("coach-idle"),
    "resetCoaching no longer writes the idle line — the guard below proves nothing"
  );
  ok(
    "the coach's unavailable path never shows the idle prompt",
    !coachFailurePaths.includes("coach-idle"),
    "a failed coach reverted to the idle line, promising coaching that isn't coming"
  );
  ok(
    "the coach says what still works without a provider",
    /[Ss]coring (keeps working|continues)/.test(coach)
  );
  ok(
    "the coach keys its one-shot explanation on the cause, not a boolean latch",
    coach.includes("coachLastProblemNote") && !coach.includes("coachEndpointWarned"),
    "a boolean latch swallows the second, different reason"
  );

  // 8. The toggles say why they can't run BEFORE they are used, not after.
  ok("the library's ✨ toggle has a hint element", library.includes("ai-enhance-hint"));
  ok("tab search's ✨ toggle has a hint element", tabSearch.includes("smart-search-hint"));
  for (const [label, src] of [
    ["the library", library],
    ["tab search", tabSearch],
  ]) {
    ok(`${label}'s hint follows config changes live`, src.includes("onAiConfigChange("));
  }
  const html = readFileSync(join(here, "..", "index.html"), "utf8");
  for (const id of ["ai-enhance-hint", "smart-search-hint"]) {
    ok(`#${id} exists in index.html`, html.includes(`id="${id}"`));
  }

  // 9. Buttons that can only fail are disabled, not left to fail.
  ok(
    "Setup disables its probe buttons without a native bridge",
    /aiScanBtn\.disabled = !nativeRuntime/.test(settings) &&
      /aiTestBtn\.disabled = !nativeRuntime/.test(settings)
  );

  // 10. Nobody reaches around the gate. aiConfigProblem() ignores the host, so
  //     a view calling it directly would tell a browser-preview player to go
  //     and fix their API key.
  for (const [p, src] of files) {
    if (p.endsWith("/ai.ts")) continue;
    ok(
      `${p.split("/").slice(-2).join("/")} uses the host-aware gate, not aiConfigProblem() directly`,
      !src.includes("aiConfigProblem("),
      "call aiProblem()/aiEnhanceProblem() so the no-bridge case is covered"
    );
  }
}

console.log(failures ? `\n${failures} AI-degradation check(s) failed` : "\nall AI degradation checks passed");
process.exit(failures ? 1 : 0);
