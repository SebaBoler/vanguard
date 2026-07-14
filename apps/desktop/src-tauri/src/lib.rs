mod active;
mod appconfig;
mod docs;
mod projects;
mod remote;
mod runs;
mod sidecar;
mod spawn;
mod spec;
mod taskid;
mod tasks;
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
async fn read_session(session_file: String) -> Result<active::SessionRead, String> {
    if !active::is_session_path(&session_file) {
        return Err("invalid session path".into());
    }
    active::read_session(Path::new(&session_file)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_app_config(repo_path: String) -> Result<appconfig::AppConfig, String> {
    // Strict: Settings must not treat an unreadable (hand-edit typo) config as empty defaults —
    // a Save would then replace the whole file (S6 guard b). Absent file still reads as defaults.
    appconfig::read_strict(Path::new(&repo_path))
}

#[tauri::command]
async fn write_app_config(repo_path: String, config: appconfig::AppConfig) -> Result<(), String> {
    appconfig::write(Path::new(&repo_path), &config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_docs(repo_path: String) -> Result<Vec<String>, String> {
    Ok(docs::list(Path::new(&repo_path)))
}

#[tauri::command]
async fn read_doc(repo_path: String, name: String) -> Result<String, String> {
    docs::read(Path::new(&repo_path), &name)
}

#[tauri::command]
async fn write_doc(repo_path: String, name: String, content: String) -> Result<(), String> {
    docs::write(Path::new(&repo_path), &name, &content)
}

#[tauri::command]
async fn list_remote_runs(repo_path: String) -> Result<Vec<remote::RemoteRun>, String> {
    remote::list_remote_runs(Path::new(&repo_path))
}

#[tauri::command]
async fn list_tasks(repo_path: String) -> Result<Vec<tasks::Task>, String> {
    tasks::list_tasks(Path::new(&repo_path))
}

#[tauri::command]
async fn fetch_spec(repo_path: String, task_id: String) -> Result<String, String> {
    spec::fetch_spec(Path::new(&repo_path), &task_id)
}

#[tauri::command]
async fn spawn_run(app: tauri::AppHandle, cwd: String, command: String) -> Result<u32, String> {
    spawn::spawn(app, cwd, command).map_err(|e| e.to_string())
}

#[tauri::command]
async fn kill_run(state: tauri::State<'_, spawn::SpawnState>, pid: u32) -> Result<(), String> {
    spawn::kill(&state, pid);
    Ok(())
}

#[tauri::command]
async fn list_spawns(state: tauri::State<'_, spawn::SpawnState>) -> Result<Vec<spawn::SpawnInfo>, String> {
    Ok(spawn::list_spawns(&state))
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
        .manage(spawn::SpawnState::default())
        .manage(sidecar::Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            list_runs,
            read_run,
            list_projects,
            add_project,
            remove_project,
            list_active,
            read_session,
            read_app_config,
            write_app_config,
            list_docs,
            read_doc,
            write_doc,
            list_remote_runs,
            list_tasks,
            fetch_spec,
            spawn_run,
            kill_run,
            list_spawns,
            watch_project,
            unwatch_project,
            sidecar::api_capabilities,
            sidecar::api_complete,
            sidecar::api_create_run,
            sidecar::api_active_run,
            sidecar::api_run_backlog,
            sidecar::api_cancel,
            sidecar::api_create_task,
            sidecar::api_list_flows,
            sidecar::api_list_providers,
            sidecar::api_read_flow,
            sidecar::api_write_flow,
            sidecar::api_repo_ok
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
