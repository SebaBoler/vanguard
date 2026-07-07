mod runs;

use std::path::Path;

#[tauri::command]
async fn list_runs(repo_path: String) -> Result<Vec<runs::RunSummary>, String> {
    runs::list_run_summaries(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_run(
    repo_path: String,
    task_id: String,
    timestamp: String,
) -> Result<runs::RunDetail, String> {
    runs::read_run_detail(Path::new(&repo_path), &task_id, &timestamp).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![list_runs, read_run])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
