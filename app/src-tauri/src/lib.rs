mod audio;
mod chords;

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
fn stop_audio(state: State<AudioState>) {
    state.stop();
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
            stop_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
