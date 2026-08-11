mod audio;
mod backing;
mod chords;
mod enhance;
mod ios_audio;
mod library;
mod settings;
mod soundfont;
mod tabsearch;

use std::sync::Mutex;

use audio::{AudioState, Mode};
use backing::{BackingState, BackingStatus};
use base64::Engine as _;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    // Manager brings `app.state()`, used in setup() to apply the saved tuning
    // before the first audio stream opens.
    AppHandle, Manager, Runtime, State, Url, WebviewUrl, WebviewWindowBuilder,
};

// ---- OpenRouter OAuth return hook (ported from Wormdrop Battleground) ----
//
// The OpenRouter PKCE login (src/openrouter.ts) navigates the whole webview to
// openrouter.ai/auth and asks it to redirect back with ?code=…. OpenRouter only
// accepts http(s) callback URLs, so the packaged app — whose origin is
// tauri://localhost (http://tauri.localhost on Windows) — hands it the
// localhost sentinel below instead. Nothing actually serves that address: this
// hook catches the redirect before it 404s, cancels it, and re-enters the app
// at its real origin carrying the same query string, so the JS completion path
// finishes the code-for-key exchange exactly as it does in a plain browser.
const OPENROUTER_CALLBACK_PATH: &str = "/openrouter-callback";

// The app URL the webview most recently displayed (dev URL or
// tauri://localhost). Tracked LIVE, not pinned once: a dev session can host two
// copies of the app (the dev server and the bundled assets), and the OAuth
// return must re-enter the copy the login actually started from — its origin
// holds the PKCE verifier (localStorage is per-origin).
static APP_URL: Mutex<Option<Url>> = Mutex::new(None);

fn remember_app_url(url: &Url) {
    *APP_URL.lock().expect("app url lock poisoned") = Some(url.clone());
}

fn is_openrouter_callback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.path() == OPENROUTER_CALLBACK_PATH
}

// OpenRouter's login stack (Clerk + bot protection) sometimes finishes an
// embedded-webview sign-in by landing on the openrouter.ai homepage instead of
// resuming the /auth authorize flow — the webview has no back button, so the
// player would be stranded outside the app. The webview only ever visits
// openrouter.ai for this login, so any arrival at its homepage is that strand:
// bounce back into the app with a marker the JS turns into a "tap Connect
// again" message (the session cookie survives, so the retry goes straight to
// the authorize screen).
const OPENROUTER_STRAND_MARKER_PATH: &str = "/openrouter-stranded";

// Client-side route changes (Next.js) never reach the native navigation hook,
// so a strand that happens via SPA routing would go unseen. This script,
// injected into every page, forces a real navigation the hook can intercept
// whenever an openrouter.ai page settles on the homepage path.
const OPENROUTER_STRAND_WATCH_JS: &str = r#"
(function () {
  if (window.location.hostname !== "openrouter.ai") { return; }
  setInterval(function () {
    if (window.location.pathname === "/") {
      window.location.replace("http://localhost/openrouter-stranded");
    }
  }, 500);
})();
"#;

fn is_openrouter_strand(url: &Url) -> bool {
    (url.host_str() == Some("openrouter.ai") && url.path() == "/")
        || (matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
            && url.path() == OPENROUTER_STRAND_MARKER_PATH)
}

fn app_reentry_url(query: Option<&str>) -> Url {
    let mut target = APP_URL
        .lock()
        .expect("app url lock poisoned")
        .clone()
        .unwrap_or_else(|| {
            let origin = if cfg!(windows) {
                "http://tauri.localhost/"
            } else {
                "tauri://localhost/"
            };
            Url::parse(origin).expect("static app origin must parse")
        });
    target.set_path("/");
    target.set_query(query);
    target.set_fragment(None);
    target
}

fn openrouter_oauth_return<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("openrouter-oauth-return")
        .js_init_script(OPENROUTER_STRAND_WATCH_JS.to_string())
        .setup(|app, _api| {
            // Deterministic origin pin: the config knows the dev URL the
            // webview loads from; in production dev_url is None and the
            // tauri:// fallback is correct.
            if let Some(dev_url) = app.config().build.dev_url.clone() {
                remember_app_url(&dev_url);
            }
            Ok(())
        })
        .on_webview_ready(|webview| {
            // Pin the app origin as soon as the webview exists: relying on the
            // navigation hook to see the very first load is timing-dependent
            // per platform.
            if let Ok(url) = webview.url() {
                if matches!(url.scheme(), "http" | "tauri") {
                    remember_app_url(&url);
                }
            }
        })
        .on_navigation(|webview, url| {
            let target = if is_openrouter_callback(url) {
                // OpenRouter redirects with ONLY ?code=… — the callback URL's
                // own query (our openrouter_callback=1 marker) is stripped.
                // The JS return-leg detection needs marker AND code, so
                // re-stamp it.
                let query = match url.query() {
                    Some(q) if q.contains("openrouter_callback=") => q.to_string(),
                    Some(q) if !q.is_empty() => format!("openrouter_callback=1&{q}"),
                    _ => "openrouter_callback=1".to_string(),
                };
                Some(app_reentry_url(Some(&query)))
            } else if is_openrouter_strand(url) {
                Some(app_reentry_url(Some("openrouter_stranded=1")))
            } else {
                None
            };
            if let Some(target) = target {
                let webview = webview.clone();
                // Deferred: navigating from inside the navigation policy
                // handler would re-enter the webview while it awaits this
                // verdict.
                tauri::async_runtime::spawn(async move {
                    let _ = webview.navigate(target);
                });
                return false;
            }
            // Every non-intercepted app-scheme navigation updates the origin
            // the next OAuth return should land on (https pages are
            // OpenRouter's side of the flow; about:blank and friends are
            // noise).
            if matches!(url.scheme(), "http" | "tauri") {
                remember_app_url(url);
            }
            true
        })
        .build()
}

#[tauri::command]
fn start_tuner(app: AppHandle, state: State<AudioState>) -> Result<(), String> {
    state.start(app, Mode::Tuner)
}

#[tauri::command]
fn stop_tuner(state: State<AudioState>) {
    state.stop();
}

#[tauri::command]
fn start_chords(app: AppHandle, state: State<AudioState>) -> Result<(), String> {
    state.start(app, Mode::Chord)
}

#[tauri::command]
fn set_mode(mode: String, state: State<AudioState>) {
    state.set_mode(match mode.as_str() {
        "chord" => Mode::Chord,
        _ => Mode::Tuner,
    });
}

/// Set the target chord by name (e.g. "Am"). Pass null/empty to clear.
#[tauri::command]
fn set_target(chord: Option<String>, state: State<AudioState>) {
    let pcs = chord.and_then(|c| chords::pitch_classes_for(&c));
    state.set_target(pcs);
}

#[tauri::command]
fn set_gate(gate: f32, state: State<AudioState>) {
    state.set_gate(gate);
}

#[tauri::command]
fn stop_audio(state: State<AudioState>) {
    state.stop();
}

/// Set the instrument tuning ("standard" | "baritone") the tuner snaps to.
/// Applies mid-stream, so switching while listening is fine.
#[tauri::command]
fn set_tuning(tuning: String, state: State<AudioState>) {
    state.set_tuning(audio::Tuning::from_str(&tuning));
}

/// Normalize a messy pasted tab into clean ChordPro via the configured AI
/// provider. Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn enhance_tab(
    app: AppHandle,
    raw: String,
    mode: Option<String>,
    lyrics: Option<String>,
    config: enhance::AiConfig,
) -> Result<String, String> {
    let m = match mode.as_deref() {
        Some("midi") => enhance::Mode::Midi,
        Some("fuse") => enhance::Mode::Fuse,
        _ => enhance::Mode::Messy,
    };
    tauri::async_runtime::spawn_blocking(move || {
        enhance::enhance_tab(&app, &raw, m, lyrics.as_deref(), &config)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Turn a digest of graded bars into short practice advice via the configured AI
/// provider.
///
/// Same shape as `enhance_tab`: the request is made from Rust so the API key never
/// reaches the webview, and on a blocking thread so a slow provider can't stall the
/// UI mid-song. `reason` is what triggered the request (section boundary, pause,
/// rough patch) and is passed to the model as context.
#[tauri::command]
async fn coach_bars(
    app: AppHandle,
    digest: String,
    reason: String,
    config: enhance::AiConfig,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        enhance::coach_bars(&app, &digest, &reason, &config)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Scan a remote endpoint's model catalog for the Setup view's model picker.
#[tauri::command]
async fn ai_models(config: enhance::AiConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || enhance::list_models(&config))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

/// Live-fire test of the configured provider; returns the model's reply.
#[tauri::command]
async fn test_ai(app: AppHandle, config: enhance::AiConfig) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || enhance::test_connection(&app, &config))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

// ---- in-app tab search (Ultimate Guitar) ----

/// Search for chord tabs. `smart` first expands a fuzzy description into
/// concrete queries through the configured AI provider; any failure there (no
/// provider set up, endpoint down) degrades to a plain search so smart mode
/// is never less capable than the plain one. Blocking network, so off the
/// main thread.
#[tauri::command]
async fn search_tabs(
    app: AppHandle,
    query: String,
    smart: Option<bool>,
    config: Option<enhance::AiConfig>,
) -> Result<tabsearch::SearchOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let queries = match (smart.unwrap_or(false), &config) {
            (true, Some(cfg)) => enhance::interpret_search(&app, cfg, &query)
                .ok()
                .filter(|qs| !qs.is_empty())
                .unwrap_or_else(|| vec![query.clone()]),
            _ => vec![query.clone()],
        };
        tabsearch::run_search(&queries)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Fetch a tab page and return its text + metadata for the paste box.
#[tauri::command]
async fn fetch_tab(url: String) -> Result<tabsearch::TabContent, String> {
    tauri::async_runtime::spawn_blocking(move || tabsearch::fetch_tab(&url))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

/// Open a tab page in an in-app preview window (a second Tauri webview — the
/// system WebKit/WebView2), so the user can eyeball a tab without leaving the
/// app. One shared window, reused/navigated on subsequent opens. The remote
/// page gets no IPC: capabilities only cover the "main" window, so this is a
/// plain sandboxed browser view.
#[tauri::command]
fn open_tab_page(app: AppHandle, url: String) -> Result<(), String> {
    tabsearch::validate_tab_url(&url)?;
    if let Some(w) = app.get_webview_window("tab-preview") {
        let js_url = serde_json::to_string(&url).map_err(|e| e.to_string())?;
        w.eval(&format!("window.location.replace({js_url})"))
            .map_err(|e| format!("navigate preview: {e}"))?;
        let _ = w.unminimize();
        let _ = w.set_focus();
    } else {
        let external = url
            .parse()
            .map_err(|e| format!("bad url: {e}"))?;
        WebviewWindowBuilder::new(&app, "tab-preview", WebviewUrl::External(external))
            .title("ukejam — tab preview")
            .inner_size(1080.0, 840.0)
            .build()
            .map_err(|e| format!("open preview window: {e}"))?;
    }
    Ok(())
}

/// Trade an OpenRouter PKCE auth code for an API key (see openrouter.ts).
#[tauri::command]
async fn openrouter_exchange(code: String, verifier: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || enhance::openrouter_exchange(&code, &verifier))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

/// The OS the native side was compiled for ("ios", "android", "macos",
/// "linux", "windows") — lets the frontend hide desktop-only affordances.
#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

// ---- backing-track playback (rustysynth) ----

/// Load MIDI as the backing track. `midi` is base64 (decoded here, rather than
/// shipped as a JSON array of integers — ~4x smaller over IPC). `channels`
/// (optional) restricts playback to those MIDI channels (0..15) — e.g. bass +
/// drums only.
#[tauri::command]
fn load_backing(
    app: AppHandle,
    midi: String,
    channels: Option<Vec<u8>>,
    state: State<BackingState>,
) -> Result<f64, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(midi.as_bytes())
        .map_err(|e| format!("decode midi: {e}"))?;
    state.load(&app, bytes, channels)
}

/// Re-filter the already-loaded backing track to a new channel set without
/// resending the file — keeps the current position/play state (track picker).
#[tauri::command]
fn set_backing_channels(
    app: AppHandle,
    channels: Option<Vec<u8>>,
    state: State<BackingState>,
) -> Result<f64, String> {
    state.set_channels(&app, channels)
}

#[tauri::command]
fn play_backing(app: AppHandle, state: State<BackingState>) -> Result<(), String> {
    state.play(app)
}

#[tauri::command]
fn pause_backing(state: State<BackingState>) {
    state.pause();
}

#[tauri::command]
fn stop_backing(state: State<BackingState>) {
    state.stop();
}

#[tauri::command]
fn set_backing_loop(looping: bool, state: State<BackingState>) {
    state.set_looping(looping);
}

#[tauri::command]
fn backing_status(state: State<BackingState>) -> BackingStatus {
    state.status()
}

/// Keep the screen awake while the transport is running. A play-along app goes
/// untouched for whole songs, so the default auto-lock would black out the
/// chord highway mid-verse. No-op off iOS.
#[tauri::command]
fn set_keep_awake(app: AppHandle, awake: bool) {
    ios_audio::set_idle_timer_disabled(&app, awake);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // The WebContent process can die under memory pressure (field-hit in
    // Wormdrop right after the OpenRouter OAuth round trip) and tauri's
    // default leaves a dead view until something reloads it at the start URL —
    // dropping the query (and with it the one-shot auth code). Reload the URL
    // the crash happened on instead.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(|webview| {
        if let Ok(current) = webview.url() {
            let _ = webview.navigate(current);
        }
    });
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_local_llm::init())
        .plugin(tauri_plugin_web_auth::init())
        .plugin(openrouter_oauth_return())
        .manage(AudioState::default())
        .manage(BackingState::default())
        .setup(|app| {
            // Watch for interruptions (calls, Siri) and route changes
            // (headphones unplugged) so audio recovers without the user
            // restarting by hand.
            ios_audio::install_observers(app.handle().clone());
            // Apply the saved tuning before the first stream starts, so the
            // tuner is right on a cold launch rather than after the frontend
            // gets around to telling us.
            let saved = settings::load(app.handle());
            app.state::<AudioState>()
                .set_tuning(audio::Tuning::from_str(&saved.tuning));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_tuner,
            stop_tuner,
            start_chords,
            set_mode,
            set_target,
            set_gate,
            stop_audio,
            set_tuning,
            enhance_tab,
            coach_bars,
            ai_models,
            test_ai,
            openrouter_exchange,
            search_tabs,
            fetch_tab,
            open_tab_page,
            load_backing,
            set_backing_channels,
            play_backing,
            pause_backing,
            stop_backing,
            set_backing_loop,
            backing_status,
            set_keep_awake,
            platform,
            library::library_load,
            library::library_save,
            settings::get_settings,
            settings::set_settings,
            soundfont::soundfont_status,
            soundfont::download_soundfont,
            soundfont::open_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
