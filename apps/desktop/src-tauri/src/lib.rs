mod active;
mod projects;
mod runs;
mod watch;

use std::path::{Path, PathBuf};
use tauri::Manager;

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

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

#[tauri::command]
async fn list_projects(app: tauri::AppHandle) -> Result<Vec<projects::Project>, String> {
    projects::list(&config_dir(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_project(app: tauri::AppHandle, path: String) -> Result<Vec<projects::Project>, String> {
    projects::add(&config_dir(&app)?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_project(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<projects::Project>, String> {
    projects::remove(&config_dir(&app)?, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_active(repo_path: String) -> Result<Vec<active::ActiveRun>, String> {
    active::list_active(Path::new(&repo_path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_session(session_file: String) -> Result<Vec<active::TranscriptEntry>, String> {
    if !active::is_session_path(&session_file) {
        return Err("invalid session path".into());
    }
    active::read_session(Path::new(&session_file)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn watch_project(
    app: tauri::AppHandle,
    state: tauri::State<'_, watch::WatchState>,
    repo_path: String,
) -> Result<(), String> {
    watch::start(app, &state, repo_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn unwatch_project(
    state: tauri::State<'_, watch::WatchState>,
    repo_path: String,
) -> Result<(), String> {
    watch::stop(&state, &repo_path);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            list_runs,
            read_run,
            list_projects,
            add_project,
            remove_project,
            list_active,
            read_session,
            watch_project,
            unwatch_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
