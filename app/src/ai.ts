// AI-enhance provider configuration: Apple Intelligence on-device, OpenRouter,
// or any OpenAI-compatible endpoint. The config is sent to Rust with every
// enhance/test invoke — the Rust side owns the network (no webview CORS
// against arbitrary hosts). Same provider approach as Wormdrop Battleground's
// AI connection setup.
//
// The durable store is app-data `settings.json`, written through the Rust
// `get_settings`/`set_settings` commands, for the same reason the song library
// moved off localStorage: the webview store is evictable under disk pressure
// on iOS, and losing a saved OpenRouter key silently signs the player out.
// localStorage survives as (a) the one-time migration source for configs saved
// before this moved native and (b) the store when running without the Tauri
// runtime (`pnpm dev` in a plain browser tab).

import { invoke } from "@tauri-apps/api/core";

export type AiProviderId = "apple" | "openrouter" | "openai";

export interface AiConfig {
  provider: AiProviderId;
  /** Custom endpoint base for "openai"; fixed for openrouter; unused for apple. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export const AI_PROVIDERS: Record<
  AiProviderId,
  { id: AiProviderId; label: string; defaultBaseUrl: string; defaultModel: string }
> = {
  apple: {
    id: "apple",
    label: "On this device (Apple Intelligence)",
    defaultBaseUrl: "",
    defaultModel: "apple-on-device",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: OPENROUTER_BASE_URL,
    defaultModel: "anthropic/claude-sonnet-4.5",
  },
  openai: {
    id: "openai",
    label: "OpenAI-compatible endpoint",
    defaultBaseUrl: OPENAI_BASE_URL,
    defaultModel: "gpt-4.1-mini",
  },
};

const STORAGE_KEY = "ukejam.ai.v1";
const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function isProviderId(value: unknown): value is AiProviderId {
  return value === "apple" || value === "openrouter" || value === "openai";
}

function normalize(saved: Partial<AiConfig> | null | undefined): AiConfig {
  const provider = isProviderId(saved?.provider) ? saved.provider : "openrouter";
  return {
    provider,
    baseUrl: typeof saved?.baseUrl === "string" ? saved.baseUrl : "",
    apiKey: typeof saved?.apiKey === "string" ? saved.apiKey : "",
    model:
      typeof saved?.model === "string" && saved.model ? saved.model : AI_PROVIDERS[provider].defaultModel,
  };
}

function loadLocal(): AiConfig {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    // Corrupt storage falls back to defaults.
    return normalize(null);
  }
}

/** The synchronous seed, replaced by the native store once `aiConfigReady`. */
export function loadAiConfig(): AiConfig {
  return loadLocal();
}

/** The settings.json shape (Rust `settings::Settings`). */
interface NativeSettings {
  ai?: AiConfig | null;
}

/**
 * Read the durable store into `config` (mutated in place so callers can hold
 * one live object), migrating a localStorage-era config up on first run.
 * Resolves to true when something was loaded, so the UI can re-render.
 */
export async function hydrateAiConfig(config: AiConfig): Promise<boolean> {
  if (!native) return false;
  try {
    const stored = await invoke<NativeSettings>("get_settings");
    if (stored?.ai) {
      Object.assign(config, normalize(stored.ai));
      return true;
    }
    // First run after the localStorage era: promote the old config. The
    // localStorage copy is left in place as a safety net.
    if (localStorage.getItem(STORAGE_KEY)) {
      await saveAiConfig(config);
      return true;
    }
  } catch {
    // No settings yet, or the native call failed — keep the seeded config.
  }
  return false;
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  // Always mirror to localStorage: it is the store in a plain browser, and a
  // harmless duplicate (plus migration safety net) in the packaged app.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Quota/denied storage: fall through to the native write.
  }
  if (!native) return;
  try {
    await invoke("set_settings", { settings: { ai: config } });
  } catch {
    // A failed native write leaves the localStorage copy as the fallback.
  }
}

/** The payload shape Rust's `AiConfig` deserializes, with defaults resolved. */
export function invokeAiConfig(config: AiConfig) {
  const baseUrl =
    config.provider === "openrouter"
      ? OPENROUTER_BASE_URL
      : config.provider === "openai"
        ? config.baseUrl.trim() || OPENAI_BASE_URL
        : "";
  return {
    provider: config.provider,
    baseUrl,
    apiKey: config.apiKey.trim(),
    model: config.model.trim() || AI_PROVIDERS[config.provider].defaultModel,
  };
}

/**
 * Why AI enhance can't run yet, or null when it can. Apple availability is
 * probed asynchronously by the caller and passed in.
 */
export function aiConfigProblem(config: AiConfig, appleStatus: string): string | null {
  if (config.provider === "apple") {
    return appleStatus === "available"
      ? null
      : `Apple Intelligence is unavailable (${appleAvailabilityHint(appleStatus)})`;
  }
  if (config.provider === "openrouter" && !config.apiKey.trim()) {
    return "OpenRouter needs an API key";
  }
  if (!config.model.trim() && !AI_PROVIDERS[config.provider].defaultModel) {
    return "no model selected";
  }
  return null;
}

/**
 * Player-facing wording for a non-`available` on-device status, mirroring the
 * plugin's availability enum.
 */
export function appleAvailabilityHint(status: string): string {
  switch (status) {
    case "unsupportedHost":
      return "Apple devices only";
    case "unsupportedOS":
      return "needs iOS 26+ / macOS 26+";
    case "deviceNotEligible":
      return "device not eligible";
    case "appleIntelligenceNotEnabled":
      return "enable Apple Intelligence in system settings";
    case "modelNotReady":
      return "model still downloading";
    case "languageNotSupported":
      return "language not supported";
    default:
      return "unavailable";
  }
}
