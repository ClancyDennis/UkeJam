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
    model: resolvedModel(config),
  };
}

/**
 * The model id actually sent. Fixed-endpoint providers get their default filled
 * in — `anthropic/claude-sonnet-4.5` is a real model on OpenRouter and
 * `apple-on-device` is the only one there is — but a CUSTOM endpoint does not:
 * substituting `gpt-4.1-mini` into a request aimed at LM Studio or Ollama sends
 * a model that host has never heard of, and its 404 reads like a broken app
 * rather than an empty Model field. Sending the blank through instead lets
 * Rust's own "no model selected" guard (enhance.rs) name the real cause, and
 * `aiConfigProblem` below stops it before it ever gets that far.
 */
function resolvedModel(config: AiConfig): string {
  const model = config.model.trim();
  if (model) return model;
  return config.provider === "openai" ? "" : AI_PROVIDERS[config.provider].defaultModel;
}

/** The hostname of a base URL, for naming it in a message. */
function endpointHost(baseUrl: string): string {
  return parseEndpoint(baseUrl)?.hostname ?? "";
}

function parseEndpoint(baseUrl: string): URL | null {
  const raw = baseUrl.trim();
  if (!raw) return null;
  try {
    // A host typed without a scheme ("localhost:1234/v1") is what people
    // actually paste for a local server, so assume http rather than reject it.
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/**
 * Whether this endpoint is one of the keyless-by-design local servers — LM
 * Studio, Ollama's compatible API, llama.cpp, a dev proxy on the LAN.
 *
 * This is the difference between "no API key" being a valid choice and being a
 * misconfiguration. A blank key against a loopback server is normal and works;
 * a blank key against a host on the public internet is a guaranteed 401, so it
 * is worth saying so before the request rather than relaying the rejection.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const host = parseEndpoint(baseUrl)?.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  // Loopback, and the three private IPv4 ranges (RFC 1918) a LAN dev box sits on.
  return (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/**
 * Why AI enhance can't run yet, or null when it can. Apple availability is
 * probed asynchronously by the caller and passed in.
 *
 * Every AI feature funnels through here BEFORE it invokes, so an unconfigured
 * provider costs a status line rather than a doomed round trip whose error the
 * player then has to interpret.
 */
export function aiConfigProblem(config: AiConfig, appleStatus: string): string | null {
  if (config.provider === "apple") {
    return appleStatus === "available"
      ? null
      : `Apple Intelligence is unavailable (${appleAvailabilityHint(appleStatus)})`;
  }
  if (config.provider === "openrouter") {
    return config.apiKey.trim() ? null : "OpenRouter needs an API key";
  }
  // A custom OpenAI-compatible endpoint. Both fields are genuinely optional
  // depending on the host, so each is judged against the endpoint rather than
  // required outright.
  const { baseUrl, apiKey } = invokeAiConfig(config);
  if (!baseUrl) return "no endpoint address";
  if (!parseEndpoint(baseUrl)) return `"${baseUrl.trim()}" isn't a usable endpoint address`;
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    return `${endpointHost(baseUrl)} needs an API key`;
  }
  // Unlike the fixed-endpoint providers there is no safe default to fall back
  // on here — see resolvedModel above.
  if (!resolvedModel(config)) return "no model selected";
  return null;
}

/** Nothing in Setup can fix a host with no native bridge, so it says so itself. */
export const AI_NEEDS_NATIVE_APP =
  "AI features need the installed app — this preview can't reach a provider";

/** Why AI can't run at all here, regardless of configuration. */
export function aiHostProblem(nativeRuntime: boolean): string | null {
  return nativeRuntime ? null : AI_NEEDS_NATIVE_APP;
}

export interface AiProblem {
  /** Player-facing reason, without a trailing pointer or punctuation. */
  message: string;
  /** Whether ⚙ Setup is where this gets fixed (a host problem is not). */
  fixable: boolean;
}

/**
 * The one gate every AI feature asks. Host first: with no native bridge the
 * configuration is irrelevant, and telling someone to open Setup when Setup
 * cannot help is worse than saying nothing.
 */
export function aiProblem(
  config: AiConfig,
  appleStatus: string,
  nativeRuntime: boolean
): AiProblem | null {
  const host = aiHostProblem(nativeRuntime);
  if (host) return { message: host, fixable: false };
  const configured = aiConfigProblem(config, appleStatus);
  return configured ? { message: configured, fixable: true } : null;
}

/**
 * The problem as a whole sentence, with the pointer to where it gets fixed.
 * Composed here rather than at each call site so the "open ⚙ Setup" advice can
 * never be attached to something Setup can't fix.
 */
export function aiProblemNote(problem: AiProblem): string {
  return problem.fixable ? `${problem.message} — open ⚙ Setup` : problem.message;
}

/** Errors cross the Tauri bridge as plain strings; this is that sentinel. */
const NATIVE_UNAVAILABLE = "native runtime unavailable";
const MAX_FAILURE_CHARS = 200;

/**
 * Player-facing text for a rejected AI invoke. Two jobs: translate the bridge's
 * internal "native runtime unavailable" (which means the browser preview, not a
 * provider fault) and keep a verbose endpoint error from overrunning a
 * single-line status.
 */
export function describeAiFailure(error: unknown): string {
  const text = (
    typeof error === "string" ? error : String((error as Error)?.message ?? error ?? "")
  ).trim();
  if (!text) return "the provider failed without saying why";
  if (text.includes(NATIVE_UNAVAILABLE)) return AI_NEEDS_NATIVE_APP;
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS - 1)}…` : text;
}

/**
 * Player-facing wording for a non-`available` on-device status, mirroring the
 * plugin's availability enum (tauri-plugin-local-llm/src/models.rs).
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
