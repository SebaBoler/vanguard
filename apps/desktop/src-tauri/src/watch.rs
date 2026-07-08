use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// The event React listens for; payload is the repo path that changed.
pub const CHANGED_EVENT: &str = "vanguard:changed";

/// Live watchers keyed by repo path — held so they stay alive and can be dropped on unwatch.
#[derive(Default)]
pub struct WatchState(pub Mutex<HashMap<String, RecommendedWatcher>>);

/// Watch a repo's `.vanguard/` and emit a debounced `vanguard:changed` on any change.
pub fn start(app: AppHandle, state: &WatchState, repo_path: String) -> notify::Result<()> {
    // Replace any existing watcher for this path (idempotent re-entry).
    stop(state, &repo_path);

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            // Sender may be gone if the debounce thread exited; ignore.
            let _ = tx.send(());
        }
    })?;

    // When `.vanguard/` exists, watch it recursively. When it doesn't yet (fresh repo),
    // watch the repo root NON-recursively — enough to notice `.vanguard` appearing without
    // drowning in node_modules/.git writes and re-fetching on every unrelated file save.
    // ponytail: a repo opened before `.vanguard` exists won't deep-watch until re-opened;
    // real projects are added with `.vanguard/` already present, so this is rare.
    let vanguard_dir = Path::new(&repo_path).join(".vanguard");
    let (target, mode) = if vanguard_dir.exists() {
        (vanguard_dir, RecursiveMode::Recursive)
    } else {
        (Path::new(&repo_path).to_path_buf(), RecursiveMode::NonRecursive)
    };
    watcher.watch(&target, mode)?;

    // Debounce: coalesce bursts (a run writes several files at once) into one emit per ~300ms.
    let repo_for_thread = repo_path.clone();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            thread::sleep(Duration::from_millis(300));
            while rx.try_recv().is_ok() {}
            let _ = app.emit(CHANGED_EVENT, &repo_for_thread);
        }
    });

    state.0.lock().unwrap().insert(repo_path, watcher);
    Ok(())
}

/// Stop watching a repo (dropping the watcher ends its debounce thread).
pub fn stop(state: &WatchState, repo_path: &str) {
    state.0.lock().unwrap().remove(repo_path);
}
