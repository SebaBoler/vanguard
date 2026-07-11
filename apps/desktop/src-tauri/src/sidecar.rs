use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// The persistent `vanguard __sidecar` child (None until first use). Single-in-flight by design: the
/// mutex serializes requests over the one stdio pipe, matching the v0 protocol (no concurrent runs).
#[derive(Default)]
pub struct Sidecar(pub Mutex<Option<SidecarProc>>);

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
/// operator LLM/platform credentials pass through, §12). `exec` replaces the shell so the child owns
/// the stdio pipes directly.
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
/// event line. Holds the lock for the whole exchange (single-in-flight); a closed child is dropped so
/// the next call respawns.
fn request(
    sidecar: &Sidecar,
    req: serde_json::Value,
    mut on_event: impl FnMut(serde_json::Value),
) -> Result<serde_json::Value, String> {
    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    ensure(&mut guard)?;
    // Scope the &mut borrow of the proc so `guard` can be reset to None on EOF afterwards.
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
    let resp = request(&state, serde_json::json!({ "id": "cap", "method": "capabilities" }), |_| {})?;
    resp.get("result").cloned().ok_or_else(|| "no result".to_string())
}

/// Start a run over the sidecar; each event line is re-emitted to the UI as `api:event`. Resolves with
/// the run's result (e.g. `{ prUrl }`), or rejects with the sidecar's error message.
#[tauri::command]
pub fn api_create_run(
    app: AppHandle,
    state: State<'_, Sidecar>,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = request(
        &state,
        serde_json::json!({ "id": "run", "method": "createRun", "params": params }),
        |ev| {
            let _ = app.emit("api:event", ev);
        },
    )?;
    if let Some(result) = resp.get("result") {
        return Ok(result.clone());
    }
    Err(resp
        .get("error")
        .map(|e| e.to_string())
        .unwrap_or_else(|| "no result".to_string()))
}
