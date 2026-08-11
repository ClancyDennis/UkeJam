// --- OpenRouter one-tap sign-in (PKCE) ---
// The login navigates the whole webview to openrouter.ai and back, so this
// module reloads mid-flow: the verifier (and, after the return leg, the code)
// live in storage until the exchange finishes. Ported from Wormdrop.
//
// Everything this needs from the AI settings panel arrives through `deps` at
// init rather than by importing it: aiSettings imports THIS module (for the
// Connect/Disconnect button state), so importing back would be a cycle.

import {
  buildOpenRouterAuthorizeUrl,
  buildOpenRouterLoginUrl,
  cleanOpenRouterCallbackUrl,
  cleanOpenRouterStrandUrl,
  createCodeVerifier,
  exchangeOpenRouterCodeInBrowser,
  isOpenRouterCallback,
  isOpenRouterCodeReturn,
  isOpenRouterStrand,
  openRouterCallbackUrl,
  openRouterCodeFromCallback,
  OPENROUTER_CALLBACK_PARAM,
} from "../../openrouter.ts";
import { authorizeInSystemBrowser, SystemAuthCancelled, SystemAuthUnavailable } from "../../webAuth.ts";
import { AI_PROVIDERS, saveAiConfig, type AiConfig } from "../../ai.ts";
import { nativeInvoke, nativeRuntime } from "../../native.ts";

export interface OpenRouterAuthDeps {
  /// The live config object the panel edits; sign-in writes the key into it.
  aiConfig: AiConfig;
  setAiStatus: (text: string, tone?: "" | "done" | "err") => void;
  renderAiPanel: () => void;
  /// Land the player on the Setup screen (where the OpenRouter card and its
  /// status line live) — used by every OAuth return path.
  openSetupView: () => void;
}

const OPENROUTER_PKCE_STORAGE_KEY = "ukejam.openrouter.pkce.v1";
const OPENROUTER_PKCE_MAX_AGE_MS = 15 * 60 * 1000;

type PendingPkce = { verifier: string; createdAt?: number; code?: string };

let deps: OpenRouterAuthDeps;
let aiOrActions: HTMLElement;
let aiOrLoginBtn: HTMLButtonElement;
let aiOrDisconnectBtn: HTMLButtonElement;

function pendingOpenRouterRecord(): PendingPkce | null {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const raw = storage.getItem(OPENROUTER_PKCE_STORAGE_KEY);
      if (!raw) continue;
      const saved = JSON.parse(raw) as PendingPkce;
      if (saved?.verifier && Date.now() - Number(saved.createdAt) < OPENROUTER_PKCE_MAX_AGE_MS) {
        return saved;
      }
    } catch {
      // Try the other storage implementation.
    }
  }
  return null;
}

function pendingOpenRouterVerifier(): string {
  return pendingOpenRouterRecord()?.verifier ?? "";
}

// The one-shot auth code arrives in the URL, which the return leg cleans
// immediately — persist it next to the verifier so a webview crash between
// the return and the exchange can resume at next boot instead of eating the
// sign-in (field-hit in Wormdrop: WebContent died mid-boot).
function stampPendingOpenRouterCode(code: string | null) {
  const record = pendingOpenRouterRecord();
  if (!record?.verifier || !code) return;
  const pending = JSON.stringify({ ...record, code });
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(OPENROUTER_PKCE_STORAGE_KEY, pending);
    } catch {}
  }
}

function clearOpenRouterVerifier() {
  try {
    localStorage.removeItem(OPENROUTER_PKCE_STORAGE_KEY);
  } catch {}
  try {
    sessionStorage.removeItem(OPENROUTER_PKCE_STORAGE_KEY);
  } catch {}
}

export function updateOpenRouterButtons() {
  const isOpenRouter = deps.aiConfig.provider === "openrouter";
  const hasKey = Boolean(deps.aiConfig.apiKey.trim());
  aiOrActions.hidden = !isOpenRouter;
  aiOrLoginBtn.hidden = hasKey;
  aiOrDisconnectBtn.hidden = !hasKey;
}

// The verifier must survive the round-trip through openrouter.ai. If the
// browser blocks BOTH storages (private mode, storage denied), the return
// leg could never complete — report that here, before navigating away,
// instead of silently after sign-in.
function storeOpenRouterVerifier(verifier: string): boolean {
  const pending = JSON.stringify({ verifier, createdAt: Date.now() });
  let stored = false;
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(OPENROUTER_PKCE_STORAGE_KEY, pending);
      stored = true;
    } catch {
      // Try the other storage implementation.
    }
  }
  return stored;
}

// Sign in through the OS browser sheet (iOS: ASWebAuthenticationSession),
// where the player gets a Cancel button, Safari's existing openrouter.ai
// session, Keychain autofill and passkeys — none of which exist in the app's
// own webview. The app is never unloaded, so the fragile parts of the web
// flow (verifier round-trip, return-leg detection, crash resume) simply
// don't apply on this path.
//
// Returns false when there is no native sheet on this host, which is the
// signal to fall back to the in-page redirect below.
async function startNativeOpenRouterLogin(verifier: string): Promise<boolean> {
  try {
    const callbackUrl = await authorizeInSystemBrowser({
      authUrl: await buildOpenRouterAuthorizeUrl(verifier),
      callbackParam: OPENROUTER_CALLBACK_PARAM,
    });
    const code = openRouterCodeFromCallback(callbackUrl);
    if (!code) throw new Error("OpenRouter finished without returning a sign-in code");
    await finishOpenRouterExchange(code, verifier);
    return true;
  } catch (error) {
    if (error instanceof SystemAuthUnavailable) return false;
    clearOpenRouterVerifier();
    if (error instanceof SystemAuthCancelled) {
      deps.setAiStatus("sign-in cancelled — tap Connect OpenRouter whenever you're ready");
    } else {
      deps.setAiStatus(`${error} — please try connecting again`, "err");
    }
    return true;
  }
}

async function startOpenRouterLogin() {
  const verifier = createCodeVerifier();
  if (!storeOpenRouterVerifier(verifier)) {
    deps.setAiStatus(
      "your browser is blocking site storage, so the secure sign-in can't complete — allow storage for this site and try again",
      "err"
    );
    return;
  }
  if (nativeRuntime) {
    aiOrLoginBtn.disabled = true;
    deps.setAiStatus("opening the secure OpenRouter sign-in…");
    try {
      if (await startNativeOpenRouterLogin(verifier)) return;
    } finally {
      aiOrLoginBtn.disabled = false;
    }
  }
  // No native sheet here (browser build, dev server, desktop package): the
  // page navigates to openrouter.ai and comes back with ?code=…. In the
  // packaged app the callback is a localhost sentinel OpenRouter will accept
  // (its tauri:// origin would be rejected, stranding the player on
  // openrouter.ai); the Rust hook routes that redirect back here.
  const callback = openRouterCallbackUrl(window.location.href, nativeRuntime);
  try {
    window.location.assign(await buildOpenRouterLoginUrl(callback.toString(), verifier));
  } catch (e) {
    deps.setAiStatus(`could not start the OpenRouter sign-in: ${e}`, "err");
  }
}

async function finishOpenRouterExchange(code: string, verifier: string) {
  deps.setAiStatus("finishing secure sign-in…");
  try {
    const apiKey = nativeRuntime
      ? await nativeInvoke<string>("openrouter_exchange", { code, verifier })
      : await exchangeOpenRouterCodeInBrowser(code, verifier);
    deps.aiConfig.provider = "openrouter";
    deps.aiConfig.apiKey = apiKey;
    if (!deps.aiConfig.model.trim()) deps.aiConfig.model = AI_PROVIDERS.openrouter.defaultModel;
    saveAiConfig(deps.aiConfig);
    deps.renderAiPanel();
    deps.setAiStatus("connected to OpenRouter — test the connection to be sure", "done");
  } catch (e) {
    deps.setAiStatus(`${e} — please try connecting again`, "err");
  } finally {
    clearOpenRouterVerifier();
  }
}

// The Rust navigation hook re-entered the app because OpenRouter's login flow
// dumped the webview on its homepage instead of resuming /auth (its bot
// protection severs the redirect chain in embedded webviews). The sign-in
// itself succeeded and the session cookie survived, so a plain retry goes
// straight to the authorize screen.
function reportStrandedOpenRouterLogin() {
  const url = new URL(window.location.href);
  if (!isOpenRouterStrand(url)) return;
  window.history.replaceState({}, "", cleanOpenRouterStrandUrl(url));
  deps.aiConfig.provider = "openrouter";
  saveAiConfig(deps.aiConfig);
  deps.renderAiPanel();
  deps.openSetupView();
  deps.setAiStatus(
    "OpenRouter signed you in but didn't return to the app — tap Connect OpenRouter again; you're signed in now, so it should go straight to the authorize screen",
    "err"
  );
}

async function completeOpenRouterLogin() {
  const url = new URL(window.location.href);
  const verifier = pendingOpenRouterVerifier();
  if (!isOpenRouterCallback(url) && !isOpenRouterCodeReturn(url, Boolean(verifier))) return;
  const code = url.searchParams.get("code");
  stampPendingOpenRouterCode(code);
  window.history.replaceState({}, "", cleanOpenRouterCallbackUrl(url));
  // Land back on the OpenRouter card whatever happens next — including the
  // failure paths, whose messages render there.
  deps.aiConfig.provider = "openrouter";
  saveAiConfig(deps.aiConfig);
  deps.renderAiPanel();
  deps.openSetupView();
  if (!verifier) {
    // The return leg arrived but the verifier is gone — expired (15-minute
    // limit) or dropped by the browser between the two legs. The code can't
    // be exchanged without it; say so instead of silently doing nothing.
    deps.setAiStatus(
      "sign-in returned, but its secure verifier had expired or was lost — tap Connect OpenRouter to try again",
      "err"
    );
    return;
  }
  await finishOpenRouterExchange(code ?? "", verifier);
}

// A webview crash between the return leg and the key exchange reloads the
// page with a clean URL. The code was persisted next to the verifier, so
// finish the interrupted exchange instead of losing the sign-in.
async function resumeInterruptedOpenRouterLogin() {
  const url = new URL(window.location.href);
  if (isOpenRouterCallback(url) || isOpenRouterCodeReturn(url, Boolean(pendingOpenRouterVerifier()))) return;
  const pending = pendingOpenRouterRecord();
  if (!pending?.code || !pending?.verifier || deps.aiConfig.apiKey.trim()) return;
  deps.aiConfig.provider = "openrouter";
  saveAiConfig(deps.aiConfig);
  deps.renderAiPanel();
  deps.openSetupView();
  await finishOpenRouterExchange(pending.code, pending.verifier);
}

/// Bind the OpenRouter card's controls. Must run before the AI panel's first
/// render, which asks this module for the Connect/Disconnect button state.
export function initOpenRouterAuth(d: OpenRouterAuthDeps): void {
  deps = d;
  aiOrActions = document.getElementById("ai-or-actions")!;
  aiOrLoginBtn = document.getElementById("ai-or-login") as HTMLButtonElement;
  aiOrDisconnectBtn = document.getElementById("ai-or-disconnect") as HTMLButtonElement;

  aiOrLoginBtn.addEventListener("click", () => void startOpenRouterLogin());
  aiOrDisconnectBtn.addEventListener("click", () => {
    deps.aiConfig.apiKey = "";
    saveAiConfig(deps.aiConfig);
    deps.renderAiPanel();
  });
}

/// Handle whichever return leg this page load is: a strand, a fresh callback,
/// or an exchange interrupted by a crash. Runs after the panel can render.
export function resumeOpenRouterLogin(): void {
  reportStrandedOpenRouterLogin();
  void completeOpenRouterLogin();
  void resumeInterruptedOpenRouterLogin();
}
