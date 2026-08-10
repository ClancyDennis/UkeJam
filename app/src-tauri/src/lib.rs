mod audio;
mod backing;
mod chords;
mod enhance;
mod ios_audio;
mod library;
mod settings;
mod soundfont;

use audio::{AudioState, Mode};
use backing::{BackingState, BackingStatus};
use base64::Engine as _;
use tauri::{AppHandle, Manager, State};

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

/// Normalize a messy pasted tab into clean ChordPro via the LLM proxy.
/// Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn enhance_tab(
    app: AppHandle,
    raw: String,
    mode: Option<String>,
    lyrics: Option<String>,
) -> Result<String, String> {
    let m = match mode.as_deref() {
        Some("midi") => enhance::Mode::Midi,
        Some("fuse") => enhance::Mode::Fuse,
        _ => enhance::Mode::Messy,
    };
    let ep = enhance::resolve_proxy(&settings::load(&app));
    tauri::async_runtime::spawn_blocking(move || {
        enhance::enhance_tab(&raw, m, lyrics.as_deref(), &ep.url, &ep.key)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Turn a digest of graded bars into short practice advice via the LLM proxy.
///
/// Same shape as `enhance_tab`: the request is made from Rust so the API key
/// never reaches the webview, and on a blocking thread so a slow proxy can't
/// stall the UI mid-song. `reason` is what triggered the request (section
/// boundary, pause, rough patch) and is passed to the model as context.
#[tauri::command]
async fn coach_bars(app: AppHandle, digest: String, reason: String) -> Result<String, String> {
    let ep = enhance::resolve_proxy(&settings::load(&app));
    tauri::async_runtime::spawn_blocking(move || enhance::coach_bars(&digest, &ep, &reason))
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
