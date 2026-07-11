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
/// Per-run event cap (crash guard) — a real run emits ~dozens; beyond this the oldest are dropped.
const MAX_EVENTS_PER_RUN: usize = 2000;

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
            // Only protocol messages count. Anything else on stdout (a stray log line that escaped the
            // stderr redirect, non-JSON noise) is skipped, never misread as a terminal.
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if v.get("event").is_some() {
                on_event(v);
            } else if v.get("result").is_some() || v.get("error").is_some() {
                break Ok(v);
            } else {
                continue;
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

/// Append an event to a run's backlog buffer (bounded ring — drops the oldest past the cap so the
/// terminal event is always retained).
fn buffer_push(state: &Sidecar, run_id: &str, event: &serde_json::Value) {
    if let Ok(mut buf) = state.buffer.lock() {
        let events = buf.entry(run_id.to_string()).or_default();
        events.push(event.clone());
        if events.len() > MAX_EVENTS_PER_RUN {
            events.remove(0);
        }
    }
}

/// Decide a run's invoke outcome + whether Rust must synthesize a terminal event. Success (the resp
/// carries `result`) needs none — the pipeline already streamed `run-end`. Any other case (in-band
/// `{id,error}` envelope from validation / a mid-run throw / a cancel-induced abort, OR a hard
/// `Err` from child death) has emitted no terminal, so one is synthesized: `run-cancelled` when this
/// run was cancelled, else `run-error`. This is the C1 fix — the in-band error envelope arrives as
/// `Ok(resp-without-result)`, not `Err`, so both must be handled here.
fn resolve_terminal(
    outcome: Result<serde_json::Value, String>,
    was_cancelled: bool,
) -> (Result<serde_json::Value, String>, Option<serde_json::Value>) {
    let err_msg = match &outcome {
        Ok(resp) => {
            if let Some(result) = resp.get("result") {
                return (Ok(result.clone()), None);
            }
            resp.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| "run failed".to_string())
        }
        Err(msg) => msg.clone(),
    };
    let terminal = if was_cancelled {
        serde_json::json!({ "type": "run-cancelled" })
    } else {
        serde_json::json!({ "type": "run-error", "message": err_msg })
    };
    (Err(err_msg), Some(terminal))
}

/// Whether a run's buffer already holds a terminal event, so we don't emit a second one.
fn has_terminal(state: &Sidecar, run_id: &str) -> bool {
    let Ok(buf) = state.buffer.lock() else {
        return false;
    };
    buf.get(run_id).is_some_and(|events| {
        events.iter().any(|e| {
            e.get("event")
                .and_then(|ev| ev.get("type"))
                .and_then(|t| t.as_str())
                .is_some_and(|t| matches!(t, "run-end" | "run-error" | "run-cancelled"))
        })
    })
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
    // Clear a stale cancel flag for this run so it can't leak onto a later run's terminal.
    if let Ok(mut c) = state.cancelled.lock() {
        if c.as_deref() == Some(run_id) {
            *c = None;
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

    let (result, terminal) = resolve_terminal(outcome, was_cancelled);
    if let Some(terminal) = terminal {
        // Any non-success run (error envelope or child death) synthesizes its terminal so a
        // re-attaching strip reaches a terminal state instead of hanging on "accepted" — unless a
        // terminal was already streamed (e.g. run-end emitted, then a teardown throw), to keep the
        // "exactly one terminal" guarantee.
        if !has_terminal(&state, &run_id) {
            emit_event(&app, &state, &run_id, terminal);
        }
    }
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
        // No libc dep: shell `kill -USR2` (Unix; the sidecar itself is Unix-only, spawned via `sh -c`).
        // SIGUSR2 not SIGUSR1 — SIGUSR1 is Node's reserved inspector-start signal.
        let _ = Command::new("kill").arg("-USR2").arg(pid.to_string()).status();
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

#[cfg(test)]
mod tests {
    use super::resolve_terminal;
    use serde_json::json;

    #[test]
    fn success_result_needs_no_terminal() {
        // The success line from request() is the `{id, result}` envelope.
        let (result, terminal) = resolve_terminal(Ok(json!({ "id": "run", "result": { "prUrl": "x" } })), false);
        assert_eq!(result.unwrap(), json!({ "prUrl": "x" }));
        assert!(terminal.is_none()); // run-end was already streamed by the pipeline
    }

    #[test]
    fn in_band_error_envelope_synthesizes_run_error() {
        // The common failure path: Node writes {id,error}, which request() returns as Ok(non-result).
        let outcome = Ok(json!({ "error": { "message": "boom", "kind": "internal" } }));
        let (result, terminal) = resolve_terminal(outcome, false);
        assert!(result.is_err());
        assert_eq!(terminal.unwrap(), json!({ "type": "run-error", "message": "boom" }));
    }

    #[test]
    fn cancelled_run_synthesizes_run_cancelled() {
        let outcome = Ok(json!({ "error": { "message": "aborted" } }));
        let (_result, terminal) = resolve_terminal(outcome, true);
        assert_eq!(terminal.unwrap(), json!({ "type": "run-cancelled" }));
    }

    #[test]
    fn child_death_err_also_synthesizes_terminal() {
        let (result, terminal) = resolve_terminal(Err("sidecar closed".into()), false);
        assert!(result.is_err());
        assert_eq!(terminal.unwrap(), json!({ "type": "run-error", "message": "sidecar closed" }));
    }
}
