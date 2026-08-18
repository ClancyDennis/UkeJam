// --- AI enhance provider settings (Setup screen) ---
// Seeded synchronously from localStorage, then replaced by the durable native
// store (see ai.ts); the live object travels with every enhance/test invoke.

import {
  AI_NEEDS_NATIVE_APP,
  AI_PROVIDERS,
  aiProblem as evaluateAiProblem,
  appleAvailabilityHint,
  describeAiFailure,
  hydrateAiConfig,
  invokeAiConfig,
  loadAiConfig,
  saveAiConfig,
  type AiProblem,
  type AiProviderId,
} from "../../ai.ts";
import { nativeInvoke, nativeRuntime } from "../../native.ts";
import { updateOpenRouterButtons } from "./openrouterAuth.ts";

export const aiConfig = loadAiConfig();

// Resolves once the durable store has been read. Anything that sends the
// config awaits this first, so an enhance fired seconds after launch can't go
// out with a stale seed (or, on a fresh install, an empty one).
export const aiConfigReady: Promise<void> = hydrateAiConfig(aiConfig).then((loaded) => {
  if (loaded) renderAiPanel();
});

// On-device availability, probed async at boot. Anything but "available"
// greys out the Apple option with the reason.
let appleStatus = "unsupportedHost";

let aiProviderSel: HTMLSelectElement;
let aiNoteEl: HTMLElement;
let aiBaseUrlField: HTMLElement;
let aiBaseUrlInput: HTMLInputElement;
let aiKeyField: HTMLElement;
let aiKeyInput: HTMLInputElement;
let aiModelField: HTMLElement;
let aiModelInput: HTMLInputElement;
let aiModelList: HTMLDataListElement;
let aiScanBtn: HTMLButtonElement;
let aiTestBtn: HTMLButtonElement;
let aiStatusEl: HTMLElement;

/**
 * Why AI can't run right now, or null. THE gate for every AI feature: the
 * library's ✨ enhance, tab search's ✨ smart and the practice coach all ask
 * this before invoking, so an unconfigured provider produces one honest status
 * line instead of a round trip whose failure each caller has to interpret.
 */
export function aiEnhanceProblem(): AiProblem | null {
  return evaluateAiProblem(aiConfig, appleStatus, nativeRuntime);
}

// --- change notification ---
//
// The ✨ toggles that live on OTHER screens (add-a-song, tab search) show why
// enhance would be skipped, so they have to hear about a key being pasted, a
// provider being switched, the durable store landing, or the on-device probe
// coming back. Without this they render once at boot and go stale — the exact
// shape of the bug that had a player connect OpenRouter and still be told the
// key was missing.

type AiConfigListener = () => void;
const aiConfigListeners = new Set<AiConfigListener>();

/** Run `listener` whenever the config or its availability verdict changes. */
export function onAiConfigChange(listener: AiConfigListener): () => void {
  aiConfigListeners.add(listener);
  listener();
  return () => aiConfigListeners.delete(listener);
}

function notifyAiConfigChange() {
  for (const listener of [...aiConfigListeners]) {
    try {
      listener();
    } catch (e) {
      // A stale view must not take the settings panel down with it.
      console.warn("ai config listener failed", e);
    }
  }
}

export function setAiStatus(text: string, tone: "" | "done" | "err" = "") {
  aiStatusEl.classList.remove("done", "err");
  if (tone) aiStatusEl.classList.add(tone);
  aiStatusEl.textContent = text;
}

const AI_PROVIDER_NOTES: Record<AiProviderId, string> = {
  apple:
    "Nothing leaves this device. The on-device model is small — long or messy tabs may come out better on a cloud model.",
  openrouter:
    'One account, every major model. Connect with one tap below, or create a key at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noopener">openrouter.ai/settings/keys</a> and paste it.',
  openai:
    "Works with OpenAI, LiteLLM, LM Studio, Ollama — anything speaking the OpenAI chat protocol. The API key is optional for keyless local servers.",
};

function renderAiStatusLine() {
  const problem = aiEnhanceProblem();
  if (problem) {
    // The reason is already on screen in the panel that owns it, so this line
    // says what the reason COSTS rather than repeating "open ⚙ Setup" at the
    // player while they are standing in Setup.
    setAiStatus(`${problem.message} — ✨ AI enhance will be skipped`, problem.fixable ? "" : "err");
  } else if (aiConfig.provider === "apple") {
    setAiStatus("ready — runs privately on this device", "done");
  } else {
    setAiStatus("configured — test the connection to be sure");
  }
  notifyAiConfigChange();
}

// Full structural render: provider options (with availability verdicts), field
// visibility, and current values. Not called from input handlers — rewriting
// an input's value while the user types would throw the caret away.
export function renderAiPanel() {
  aiProviderSel.replaceChildren();
  Object.values(AI_PROVIDERS).forEach((provider) => {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    if (provider.id === "apple" && appleStatus !== "available") {
      // Keep the option visible so players learn it exists, but grey it out
      // WITH the reason ("Apple devices only", "model still downloading", …) —
      // an unexplained disabled option reads as a bug.
      option.disabled = true;
      option.textContent += ` — ${appleAvailabilityHint(appleStatus)}`;
    }
    option.selected = provider.id === aiConfig.provider;
    aiProviderSel.append(option);
  });
  const provider = aiConfig.provider;
  aiBaseUrlField.hidden = provider !== "openai";
  aiKeyField.hidden = provider === "apple";
  aiModelField.hidden = provider === "apple";
  aiScanBtn.hidden = provider === "apple";
  // Both buttons make a request through Rust. In a browser preview there is no
  // Rust, so they can only ever fail — disable them WITH the reason in the
  // tooltip rather than let the player press them for a bridge error.
  aiScanBtn.disabled = !nativeRuntime;
  aiTestBtn.disabled = !nativeRuntime;
  aiScanBtn.title = nativeRuntime ? "" : AI_NEEDS_NATIVE_APP;
  aiTestBtn.title = nativeRuntime ? "" : AI_NEEDS_NATIVE_APP;
  updateOpenRouterButtons();
  aiBaseUrlInput.value = aiConfig.baseUrl || AI_PROVIDERS.openai.defaultBaseUrl;
  aiKeyInput.value = aiConfig.apiKey;
  aiModelInput.value = aiConfig.model;
  aiNoteEl.innerHTML = AI_PROVIDER_NOTES[provider];
  renderAiStatusLine();
}

async function probeAppleAvailability() {
  if (!nativeRuntime) return;
  try {
    const res = await nativeInvoke<{ status: string }>("plugin:local-llm|availability");
    appleStatus = res?.status ?? "unavailable";
  } catch {
    appleStatus = "unavailable";
  }
  renderAiPanel();
}

export function initAiSettings(): void {
  aiProviderSel = document.getElementById("ai-provider") as HTMLSelectElement;
  aiNoteEl = document.getElementById("ai-note")!;
  aiBaseUrlField = document.getElementById("ai-baseurl-field")!;
  aiBaseUrlInput = document.getElementById("ai-base-url") as HTMLInputElement;
  aiKeyField = document.getElementById("ai-key-field")!;
  aiKeyInput = document.getElementById("ai-api-key") as HTMLInputElement;
  aiModelField = document.getElementById("ai-model-field")!;
  aiModelInput = document.getElementById("ai-model") as HTMLInputElement;
  aiModelList = document.getElementById("ai-model-list") as HTMLDataListElement;
  aiScanBtn = document.getElementById("ai-scan-btn") as HTMLButtonElement;
  aiTestBtn = document.getElementById("ai-test-btn") as HTMLButtonElement;
  aiStatusEl = document.getElementById("ai-status")!;

  aiProviderSel.addEventListener("change", () => {
    const provider = aiProviderSel.value as AiProviderId;
    aiConfig.provider = provider;
    aiConfig.model = AI_PROVIDERS[provider].defaultModel;
    if (provider === "openai" && !aiConfig.baseUrl.trim()) {
      aiConfig.baseUrl = AI_PROVIDERS.openai.defaultBaseUrl;
    }
    saveAiConfig(aiConfig);
    aiModelList.replaceChildren(); // a catalog scanned from another endpoint is stale
    renderAiPanel();
  });
  aiBaseUrlInput.addEventListener("input", () => {
    aiConfig.baseUrl = aiBaseUrlInput.value;
    saveAiConfig(aiConfig);
    renderAiStatusLine();
  });
  aiKeyInput.addEventListener("input", () => {
    aiConfig.apiKey = aiKeyInput.value;
    saveAiConfig(aiConfig);
    updateOpenRouterButtons();
    renderAiStatusLine();
  });
  aiModelInput.addEventListener("input", () => {
    aiConfig.model = aiModelInput.value;
    saveAiConfig(aiConfig);
    renderAiStatusLine();
  });

  // Fill the model datalist from the endpoint's own catalog (GET /models).
  aiScanBtn.addEventListener("click", async () => {
    aiScanBtn.disabled = true;
    setAiStatus("scanning the endpoint's model catalog…");
    try {
      // The catalog must be scanned from the endpoint that is actually saved,
      // not the boot seed — a key hydrated a moment ago changes which models
      // the endpoint is willing to list.
      await aiConfigReady;
      const models = await nativeInvoke<string[]>("ai_models", { config: invokeAiConfig(aiConfig) });
      aiModelList.replaceChildren(
        ...models.map((id) => {
          const option = document.createElement("option");
          option.value = id;
          return option;
        })
      );
      if (!aiConfig.model.trim() && models.length) {
        aiConfig.model = models[0];
        aiModelInput.value = models[0];
        saveAiConfig(aiConfig);
        // Adopting a model can clear the "no model selected" problem, which the
        // ✨ toggles on other screens are showing.
        notifyAiConfigChange();
      }
      setAiStatus(
        models.length
          ? `found ${models.length} models — the Model field now autocompletes`
          : "the endpoint returned no models — enter a model id manually"
      );
    } catch (e) {
      setAiStatus(`model scan failed: ${describeAiFailure(e)}`, "err");
    } finally {
      aiScanBtn.disabled = !nativeRuntime;
    }
  });

  // A real chat round trip — the only probe that proves the key AND model work.
  aiTestBtn.addEventListener("click", async () => {
    aiTestBtn.disabled = true;
    try {
      // Same reason as the scan: test what is saved, not the seed.
      await aiConfigReady;
      const problem = aiEnhanceProblem();
      if (problem) {
        setAiStatus(problem.message, "err");
        return;
      }
      setAiStatus(
        `testing ${aiConfig.provider === "apple" ? "the on-device model" : aiConfig.model.trim()}…`
      );
      const reply = await nativeInvoke<string>("test_ai", { config: invokeAiConfig(aiConfig) });
      setAiStatus(`connection works — replied “${reply}”`, "done");
    } catch (e) {
      setAiStatus(describeAiFailure(e), "err");
    } finally {
      aiTestBtn.disabled = !nativeRuntime;
    }
  });

  renderAiPanel();
  void probeAppleAvailability();
}
