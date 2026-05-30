mod audio;
mod chords;
mod enhance;

use audio::{AudioState, Mode};
use tauri::{AppHandle, State};

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
async fn enhance_tab(raw: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || enhance::enhance_tab(&raw))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            start_tuner,
            stop_tuner,
            start_chords,
            set_mode,
            set_target,
            set_gate,
            stop_audio,
            enhance_tab
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
