// AI-enhance provider configuration. The choice (Apple Intelligence on-device,
// OpenRouter, or any OpenAI-compatible endpoint) lives in localStorage and is
// sent to Rust with every enhance/test invoke — the frontend owns persistence,
// the Rust side owns the network (no webview CORS against arbitrary hosts).
// Same provider approach as Wormdrop Battleground's AI connection setup.

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

function isProviderId(value: unknown): value is AiProviderId {
  return value === "apple" || value === "openrouter" || value === "openai";
}

export function loadAiConfig(): AiConfig {
  let saved: Partial<AiConfig> = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    // Corrupt storage falls back to defaults.
  }
  const provider = isProviderId(saved.provider) ? saved.provider : "openrouter";
  return {
    provider,
    baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : "",
    apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "",
    model: typeof saved.model === "string" && saved.model ? saved.model : AI_PROVIDERS[provider].defaultModel,
  };
}

export function saveAiConfig(config: AiConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Quota/denied storage: settings just won't survive a restart.
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
