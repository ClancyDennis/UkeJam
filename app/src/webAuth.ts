// Bridge to the native `web-auth` Tauri plugin, which runs an OAuth sign-in in
// the platform's own browser sheet (iOS: ASWebAuthenticationSession) instead of
// navigating the app's webview to the provider.
//
// That distinction is the whole feature. The app's webview is not a browser: no
// address bar, no back button, no Cancel, no Safari cookies, no Keychain
// autofill and no passkeys — so an in-webview sign-in strands the player on a
// page they can't leave with credentials they can't autofill. The system sheet
// has all of it, and the app keeps running underneath instead of unloading.
//
// Anywhere the plugin isn't present — the browser build, the dev server, a
// desktop package — `authorizeInSystemBrowser` throws `SystemAuthUnavailable`
// and the caller falls back to its own in-page redirect flow. Ported from
// Wormdrop Battleground.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

// Sentinels the Rust/Swift side rejects with (tauri-plugin-web-auth's
// `error.rs` and `WebAuthPlugin.swift`). Errors cross the bridge as plain
// strings, so these are matched as text.
const UNSUPPORTED_HOST = "unsupportedHost";
const CANCELLED = "cancelled";

/** No native sheet here — use the web sign-in path instead of reporting this. */
export class SystemAuthUnavailable extends Error {}

/** The player dismissed the sheet. A normal outcome, not a failure. */
export class SystemAuthCancelled extends Error {}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return String((error as Error)?.message ?? error ?? "");
}

/**
 * Present `authUrl` in the system browser sheet and resolve with the URL the
 * provider finally redirected to (code and all). The redirect target is NOT
 * supplied here: the plugin opens a loopback listener and appends its address
 * under `callbackParam`, because only it knows the port that was free.
 *
 * @returns the callback URL the sign-in finished on
 */
export async function authorizeInSystemBrowser({
  authUrl,
  callbackParam,
}: {
  authUrl: string;
  callbackParam: string;
}): Promise<string> {
  if (!(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)) {
    throw new SystemAuthUnavailable("No native sign-in on this host.");
  }
  let response: { callbackUrl?: string };
  try {
    response = await tauriInvoke("plugin:web-auth|authorize", {
      payload: { authUrl, callbackParam },
    });
  } catch (error) {
    const message = errorText(error);
    if (message.includes(UNSUPPORTED_HOST)) throw new SystemAuthUnavailable(message);
    if (message.includes(CANCELLED)) throw new SystemAuthCancelled(message);
    throw error instanceof Error ? error : new Error(message || "The system sign-in failed.");
  }
  const callbackUrl = response?.callbackUrl ?? "";
  if (!callbackUrl) throw new Error("The sign-in sheet returned no callback URL.");
  return callbackUrl;
}
