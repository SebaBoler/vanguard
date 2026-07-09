use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const OUTPUT_EVENT: &str = "spawn:output";
pub const EXIT_EVENT: &str = "spawn:exit";

/// Child processes launched from the UI, keyed by OS pid — held so they stay alive and can be killed.
#[derive(Default)]
pub struct SpawnState(pub Mutex<HashMap<u32, Child>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    pid: u32,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    pid: u32,
    code: Option<i32>,
}

/// Spawn `sh -c "<command> 2>&1"` in `cwd`, inheriting the app's environment (so operator LLM/platform
/// credentials pass through — §12). Streams merged output as `spawn:output`; emits `spawn:exit` on end.
/// The command is operator-supplied (a local run launcher, like a terminal) — not untrusted input.
pub fn spawn(app: AppHandle, cwd: String, command: String) -> std::io::Result<u32> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(format!("{command} 2>&1"))
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let pid = child.id();

    // Reader drains stdout; `reader_done` flips true at EOF. Starts true when there's no stdout so
    // the exit path never waits on a reader that doesn't exist.
    let reader_done = Arc::new(AtomicBool::new(true));
    if let Some(out) = child.stdout.take() {
        reader_done.store(false, Ordering::Release);
        let app_out = app.clone();
        let done = reader_done.clone();
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_out.emit(OUTPUT_EVENT, OutputEvent { pid, line });
            }
            done.store(true, Ordering::Release);
        });
    }

    app.state::<SpawnState>().0.lock().unwrap().insert(pid, child);

    // Waiter: poll try_wait under the lock so it coexists with kill(); emit exit + drop on end.
    // Before emitting exit, wait (bounded) for the stdout reader to drain so the exit line doesn't
    // race ahead of the final output lines in the UI.
    let app_wait = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        let state = app_wait.state::<SpawnState>();
        let mut map = state.0.lock().unwrap();
        match map.get_mut(&pid) {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    map.remove(&pid);
                    drop(map);
                    await_drain(&reader_done);
                    let _ = app_wait.emit(EXIT_EVENT, ExitEvent { pid, code: status.code() });
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    map.remove(&pid);
                    drop(map);
                    await_drain(&reader_done);
                    let _ = app_wait.emit(EXIT_EVENT, ExitEvent { pid, code: None });
                    break;
                }
            },
            None => break,
        }
    });

    Ok(pid)
}

/// Wait for the stdout reader to hit EOF so exit doesn't beat the last output lines — but bounded
/// (~2s), so a grandchild that inherits stdout and outlives the run can't stall the exit event
/// forever. After the cap we emit exit anyway; at worst a few trailing lines lag (cosmetic).
fn await_drain(reader_done: &AtomicBool) {
    for _ in 0..40 {
        if reader_done.load(Ordering::Acquire) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Kill a spawned run. The waiter thread then observes the exit and emits `spawn:exit`.
pub fn kill(state: &SpawnState, pid: u32) {
    if let Some(child) = state.0.lock().unwrap().get_mut(&pid) {
        let _ = child.kill();
    }
}
