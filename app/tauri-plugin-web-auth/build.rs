// Generates the per-command permission files and links the iOS Swift package.
const COMMANDS: &[&str] = &["authorize"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
