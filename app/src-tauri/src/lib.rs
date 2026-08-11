mod audio;
mod backing;
mod chords;
mod enhance;
mod soundfont;
mod tabsearch;

use audio::{AudioState, Mode};
use backing::{BackingState, BackingStatus};
use base64::Engine as _;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

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

/// Normalize a messy pasted tab into clean ChordPro via the LLM proxy.
/// Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn enhance_tab(
    raw: String,
    mode: Option<String>,
    lyrics: Option<String>,
) -> Result<String, String> {
    let m = match mode.as_deref() {
        Some("midi") => enhance::Mode::Midi,
        Some("fuse") => enhance::Mode::Fuse,
        _ => enhance::Mode::Messy,
    };
    tauri::async_runtime::spawn_blocking(move || enhance::enhance_tab(&raw, m, lyrics.as_deref()))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

// ---- in-app tab search (Ultimate Guitar) ----

/// Search for chord tabs. `smart` first expands the query with the LLM proxy
/// (fuzzy description -> concrete searches), degrading to a plain search if
/// the proxy is unreachable. Blocking network, so off the main thread.
#[tauri::command]
async fn search_tabs(query: String, smart: Option<bool>) -> Result<tabsearch::SearchOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tabsearch::run_search(&query, smart.unwrap_or(false))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioState::default())
        .manage(BackingState::default())
        .invoke_handler(tauri::generate_handler![
            start_tuner,
            stop_tuner,
            start_chords,
            set_mode,
            set_target,
            set_gate,
            stop_audio,
            enhance_tab,
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
            soundfont::soundfont_status,
            soundfont::download_soundfont,
            soundfont::open_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
