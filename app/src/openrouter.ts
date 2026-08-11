// OpenRouter PKCE login flow, ported from Wormdrop Battleground. The login
// navigates the whole webview to openrouter.ai/auth; OpenRouter redirects back
// with a one-shot ?code=… that gets exchanged (plus the locally-kept verifier)
// for a long-lived API key. In the packaged Tauri app the redirect targets a
// localhost sentinel that the Rust `openrouter-oauth-return` hook intercepts
// and re-enters the app with; in a plain browser the page's own origin is the
// callback.

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/keys";

// OpenRouter's /auth only redirects back to http(s) callback URLs — public
// sites, or localhost on any port. The packaged Tauri app doesn't live on one:
// its origin is tauri://localhost (http://tauri.localhost on Windows), which
// /auth rejects, dumping the player on the openrouter.ai homepage without ever
// showing the authorize screen. For those origins the login hands OpenRouter
// this localhost sentinel instead; nothing serves it, but the Rust side
// intercepts the redirect and re-enters the app at its real origin with the
// same ?code=… query (see openrouter_oauth_return in src-tauri/src/lib.rs).
export const OPENROUTER_NATIVE_CALLBACK_URL = "http://localhost/openrouter-callback";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function openRouterCallbackUrl(currentHref: string, inTauri: boolean): URL {
  const current = new URL(currentHref);
  // Inside Tauri the sentinel is ALWAYS the callback: the Rust hook re-enters
  // the app's real origin with the marker restored, which sidesteps two
  // Wormdrop-field-verified failure modes — OpenRouter stripping the callback
  // URL's own query on the redirect, and origins /auth rejects outright
  // (tauri://, private-LAN device-dev IPs). In a plain browser there is no
  // hook, so the page keeps its own origin — the return leg must land where
  // the stored PKCE verifier is (localStorage is per-origin).
  const reachable =
    !inTauri &&
    (current.protocol === "http:" || current.protocol === "https:") &&
    current.hostname !== "tauri.localhost";
  const callback = reachable ? current : new URL(OPENROUTER_NATIVE_CALLBACK_URL);
  callback.search = "";
  callback.hash = "";
  callback.searchParams.set("openrouter_callback", "1");
  return callback;
}

// The query parameter /auth expects the redirect target in. Named because the
// native sign-in (src/webAuth.ts) can't build the URL itself — only the Rust
// side knows the loopback address its listener ended up on — so it passes this
// name down and lets the plugin append the pair.
export const OPENROUTER_CALLBACK_PARAM = "callback_url";

async function openRouterAuthUrl(callbackUrl: string, verifier: string): Promise<string> {
  const url = new URL(OPENROUTER_AUTH_URL);
  if (callbackUrl) url.searchParams.set(OPENROUTER_CALLBACK_PARAM, callbackUrl);
  url.searchParams.set("code_challenge", await createCodeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function buildOpenRouterLoginUrl(callbackUrl: string, verifier: string): Promise<string> {
  return openRouterAuthUrl(callbackUrl, verifier);
}

/** The same authorize URL without a callback, for the native sign-in sheet. */
export function buildOpenRouterAuthorizeUrl(verifier: string): Promise<string> {
  return openRouterAuthUrl("", verifier);
}

/** The one-shot code out of whatever URL the sign-in finished on. */
export function openRouterCodeFromCallback(callbackUrl: string): string {
  try {
    return new URL(callbackUrl).searchParams.get("code") ?? "";
  } catch {
    return "";
  }
}

/**
 * Browser-only exchange (the Tauri build routes through the Rust
 * `openrouter_exchange` command instead, dodging cross-origin fetch).
 */
export async function exchangeOpenRouterCodeInBrowser(code: string, verifier: string): Promise<string> {
  const response = await fetch(OPENROUTER_KEY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!response.ok) throw new Error(`OpenRouter sign-in failed (${response.status})`);
  const payload = await response.json();
  const key = payload.key ?? payload.api_key;
  if (!key) throw new Error("OpenRouter did not return an API key");
  return key;
}

// Whether this URL is our return leg from the OpenRouter auth page: the
// marker we stamped on callback_url plus the code OpenRouter appended.
// Deliberately independent of the stored verifier, so a lost or expired
// verifier can be REPORTED on return instead of silently ignoring the
// callback.
export function isOpenRouterCallback(url: URL): boolean {
  return Boolean(url.searchParams.get("openrouter_callback") && url.searchParams.get("code"));
}

// The marker-less variant: OpenRouter strips the callback URL's own query on
// the redirect (Wormdrop field log: `?code=…` alone came back), so a `?code=`
// with a pending PKCE verifier in storage is also our return leg. The verifier
// check keeps foreign ?code= URLs from being swallowed.
export function isOpenRouterCodeReturn(url: URL, hasPendingVerifier: boolean): boolean {
  return Boolean(url.searchParams.get("code")) && hasPendingVerifier;
}

export function cleanOpenRouterCallbackUrl(url: URL): URL {
  const parsed = new URL(url.toString());
  parsed.searchParams.delete("code");
  parsed.searchParams.delete("openrouter_callback");
  return parsed;
}

// OpenRouter's login stack sometimes finishes an embedded-webview sign-in by
// dumping the player on the openrouter.ai homepage instead of resuming the
// /auth authorize flow. The Rust hook catches that and re-enters the app
// stamped with this marker. The session cookie survives the dump, so the
// recovery is a plain retry: the second /auth visit goes straight to the
// authorize screen.
export const OPENROUTER_STRANDED_PARAM = "openrouter_stranded";

export function isOpenRouterStrand(url: URL): boolean {
  return url.searchParams.get(OPENROUTER_STRANDED_PARAM) === "1";
}

export function cleanOpenRouterStrandUrl(url: URL): URL {
  const parsed = new URL(url.toString());
  parsed.searchParams.delete(OPENROUTER_STRANDED_PARAM);
  return parsed;
}
