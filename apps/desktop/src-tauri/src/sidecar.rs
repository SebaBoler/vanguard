use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Sidecar state. `proc` (the run pipe) is held for a whole run; `buffer`/`active`/`child_pid`/
/// `cancelled` use SEPARATE locks so re-attach (api_run_backlog / api_active_run) and cancel read
/// them WHILE a run holds `proc`. See docs/specs/subsystem-0.5-sidecar-hardening.md §Concurrency.
#[derive(Default)]
pub struct Sidecar {
    proc: Mutex<Option<SidecarProc>>,
    /// Per-run event backlog for re-attach. Keyed by runId; last few completed runs retained.
    buffer: Mutex<HashMap<String, Vec<serde_json::Value>>>,
    /// Completed-run ids in finish order, for bounded eviction.
    order: Mutex<Vec<String>>,
    /// The in-flight runId, or None when idle.
    active: Mutex<Option<String>>,
    /// The running child's PID, readable without the `proc` lock so cancel works during a run.
    child_pid: Mutex<Option<u32>>,
    /// A runId for which cancel was requested — its terminal is `run-cancelled`, not `run-error`.
    cancelled: Mutex<Option<String>>,
    counter: AtomicU64,
}

/// Completed runs kept in the backlog buffer before eviction.
const RETAINED_RUNS: usize = 4;

pub struct SidecarProc {
    /// Held so the process stays alive and its pipes stay open; never read directly (Drop detaches
    /// it on app shutdown). stdin/reader below own the actual I/O.
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
}

/// Spawn the sidecar if it isn't already running. Mirrors `spawn.rs`: launch through `sh -c` so
/// `vanguard` resolves on the same PATH the CLI shell-out uses, inheriting the app environment (so
/// operator LLM/platform credentials pass through). `exec` replaces the shell so the child owns the
/// stdio pipes directly.
fn ensure(proc: &mut Option<SidecarProc>) -> Result<(), String> {
    if proc.is_some() {
        return Ok(());
    }
    let mut child = Command::new("sh")
        .arg("-c")
        .arg("exec vanguard __sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn vanguard __sidecar: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *proc = Some(SidecarProc {
        child,
        stdin,
        reader: BufReader::new(stdout),
    });
    Ok(())
}

/// Write one request line, then read lines until the matching `result`/`error`. `on_event` fires per
/// event line. Holds the proc lock for the whole exchange (single-in-flight); a closed child is
/// dropped so the next call respawns.
fn request(
    state: &Sidecar,
    req: serde_json::Value,
    mut on_event: impl FnMut(serde_json::Value),
) -> Result<serde_json::Value, String> {
    let mut guard = state.proc.lock().map_err(|e| e.to_string())?;
    ensure(&mut guard)?;
    // Publish the child PID (separate lock) so api_cancel can signal it WITHOUT the proc lock a run holds.
    if let (Ok(mut pid), Some(proc)) = (state.child_pid.lock(), guard.as_ref()) {
        *pid = Some(proc.child.id());
    }
    let outcome = {
        let proc = guard.as_mut().ok_or("sidecar down")?;
        writeln!(proc.stdin, "{req}").map_err(|e| e.to_string())?;
        proc.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        loop {
            line.clear();
            if proc.reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                break Err::<serde_json::Value, String>("sidecar closed".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
            if v.get("event").is_some() {
                on_event(v);
            } else {
                break Ok(v);
            }
        }
    };
    if outcome.is_err() {
        *guard = None;
        if let Ok(mut pid) = state.child_pid.lock() {
            *pid = None;
        }
    }
    outcome
}

/// The pure capability surface (providers/flows/transports/defaults). No stdout scraping.
///
/// Sync (not `async`) on purpose: `request` holds a std Mutex across a blocking `read_line`, which
/// would stall the shared async runtime. As a plain command Tauri runs it on its own thread pool
/// thread, so a long-running exchange never blocks other IPC.
#[tauri::command]
pub fn api_capabilities(state: State<'_, Sidecar>) -> Result<serde_json::Value, String> {
    let resp = request(
        &state,
        serde_json::json!({ "id": "cap", "method": "capabilities" }),
        |_| {},
    )?;
    resp.get("result").cloned().ok_or_else(|| "no result".to_string())
}

/// Append an event to a run's backlog buffer.
fn buffer_push(state: &Sidecar, run_id: &str, event: &serde_json::Value) {
    if let Ok(mut buf) = state.buffer.lock() {
        buf.entry(run_id.to_string()).or_default().push(event.clone());
    }
}

/// Emit + buffer a `{runId, event}` payload on the `api:event` channel.
fn emit_event(app: &AppHandle, state: &Sidecar, run_id: &str, event: serde_json::Value) {
    let payload = serde_json::json!({ "runId": run_id, "event": event });
    buffer_push(state, run_id, &payload);
    let _ = app.emit("api:event", &payload);
}

/// Mark a run finished: clear `active`, record it for eviction, drop the oldest beyond RETAINED_RUNS.
fn finish_run(state: &Sidecar, run_id: &str) {
    if let Ok(mut active) = state.active.lock() {
        if active.as_deref() == Some(run_id) {
            *active = None;
        }
    }
    let evict = {
        let mut order = match state.order.lock() {
            Ok(o) => o,
            Err(_) => return,
        };
        order.push(run_id.to_string());
        if order.len() > RETAINED_RUNS {
            Some(order.remove(0))
        } else {
            None
        }
    };
    if let Some(old) = evict {
        if let Ok(mut buf) = state.buffer.lock() {
            buf.remove(&old);
        }
    }
}

/// Start a run. Mints a runId, emits `run-accepted` + every event as `{runId, event}` (buffered for
/// re-attach), and guarantees exactly one terminal event (run-end from the stream on success, else a
/// synthesized run-error / run-cancelled). Returns the run's result, or an error string.
#[tauri::command]
pub fn api_create_run(
    app: AppHandle,
    state: State<'_, Sidecar>,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let run_id = format!("run-{}", state.counter.fetch_add(1, Ordering::SeqCst));
    if let Ok(mut active) = state.active.lock() {
        *active = Some(run_id.clone());
    }
    emit_event(&app, &state, &run_id, serde_json::json!({ "type": "run-accepted" }));

    let outcome = request(
        &state,
        serde_json::json!({ "id": "run", "method": "createRun", "params": params }),
        |v| {
            // Sidecar events arrive as `{id, event}`; re-wrap as `{runId, event}` and buffer.
            if let Some(event) = v.get("event") {
                emit_event(&app, &state, &run_id, event.clone());
            }
        },
    );

    // Was this run cancelled? (api_cancel records the active runId.)
    let was_cancelled = state
        .cancelled
        .lock()
        .ok()
        .and_then(|mut c| {
            if c.as_deref() == Some(&run_id) {
                *c = None;
                Some(())
            } else {
                None
            }
        })
        .is_some();

    let result = match outcome {
        Ok(resp) => {
            // Success: the run-end event was already streamed + buffered by on_event above.
            resp.get("result")
                .cloned()
                .ok_or_else(|| resp.get("error").map(|e| e.to_string()).unwrap_or_else(|| "no result".to_string()))
        }
        Err(msg) => {
            // No terminal event was emitted on a throw — synthesize one so re-attach doesn't hang.
            let terminal = if was_cancelled {
                serde_json::json!({ "type": "run-cancelled" })
            } else {
                serde_json::json!({ "type": "run-error", "message": msg })
            };
            emit_event(&app, &state, &run_id, terminal);
            Err(msg)
        }
    };
    finish_run(&state, &run_id);
    result
}

/// The in-flight runId, or None when idle. Reads only the `active` lock, so it works during a run.
#[tauri::command]
pub fn api_active_run(state: State<'_, Sidecar>) -> Option<String> {
    state.active.lock().ok().and_then(|g| g.clone())
}

/// The buffered event backlog for a run, for a re-attaching strip. Reads only the `buffer` lock.
#[tauri::command]
pub fn api_run_backlog(state: State<'_, Sidecar>, run_id: String) -> Vec<serde_json::Value> {
    state
        .buffer
        .lock()
        .ok()
        .and_then(|b| b.get(&run_id).cloned())
        .unwrap_or_default()
}

/// Cancel the in-flight run out-of-band: SIGUSR1 to the sidecar child (an in-band stdio message would
/// queue behind the run it must cancel). Reads `child_pid`/`active` only — never the run-held `proc`
/// lock. The sidecar's handler aborts the run's AbortController without exiting.
#[tauri::command]
pub fn api_cancel(state: State<'_, Sidecar>) -> Result<(), String> {
    let active = state.active.lock().map_err(|e| e.to_string())?.clone();
    let Some(run_id) = active else {
        return Ok(()); // nothing running
    };
    if let Ok(mut c) = state.cancelled.lock() {
        *c = Some(run_id);
    }
    let pid = *state.child_pid.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pid {
        // No libc dep: shell `kill -USR1` (Unix; the sidecar itself is Unix-only, spawned via `sh -c`).
        let _ = Command::new("kill").arg("-USR1").arg(pid.to_string()).status();
    }
    Ok(())
}

/// Cheap client-side pre-flight: is `repo_path` a git work tree? Lets S1 fail a misconfigured project
/// at click instead of minutes into a run.
#[tauri::command]
pub fn api_repo_ok(repo_path: String) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(&repo_path)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
