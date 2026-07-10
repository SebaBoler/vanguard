use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// A session is considered "running" only if its newest line was written this recently.
const ACTIVE_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRun {
    pub task_id: String,
    pub session_file: String,
    pub last_activity_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    /// "assistant" (agent prose) or "tool" (a tool invocation name).
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRead {
    pub entries: Vec<TranscriptEntry>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    /// Live spend estimate in USD, priced per-message off each message's own model. Unknown models
    /// contribute nothing, so this is a lower bound — surface it as "~$" in the UI, never as exact.
    pub est_cost_usd: f64,
}

/// USD per 1M tokens as (input, output, cache_read). Ported from src/core/openrouter-pricing.ts
/// OPENROUTER_PRICING (the fuller map: aliases + bare Vanguard ids + the provider-prefixed dotted
/// slugs OpenRouter echoes back, e.g. `anthropic/claude-opus-4.8`, `z-ai/glm-5.2`) — refresh both
/// together on model/price updates. `contains` (not `starts_with`) so both `claude-opus-4-8` and
/// `anthropic/claude-opus-4.8` match. Order matters: sonnet-5 before generic sonnet keeps its rate.
fn model_price(model: &str) -> Option<(f64, f64, f64)> {
    if model.contains("claude-opus") || model == "opus" {
        Some((5.0, 25.0, 0.5))
    } else if model.contains("claude-sonnet-5") || model == "sonnet" {
        Some((2.0, 10.0, 0.2))
    } else if model.contains("claude-sonnet") {
        Some((3.0, 15.0, 0.3))
    } else if model.contains("claude-haiku") || model == "haiku" {
        Some((1.0, 5.0, 0.1))
    } else if model.contains("glm") {
        Some((0.93, 3.0, 0.18))
    } else {
        None
    }
}

fn within(t: SystemTime, now: SystemTime, w: Duration) -> bool {
    // A future mtime (clock skew) counts as "just now".
    now.duration_since(t).map(|d| d <= w).unwrap_or(true)
}

fn newest_jsonl(dir: &Path) -> Option<(PathBuf, SystemTime)> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for e in fs::read_dir(dir).ok()?.flatten() {
        if !e.file_name().to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
            if best.as_ref().is_none_or(|(_, bm)| m > *bm) {
                best = Some((e.path(), m));
            }
        }
    }
    best
}

fn newest_record_mtime(runs_task_dir: &Path) -> Option<SystemTime> {
    let mut newest: Option<SystemTime> = None;
    for e in fs::read_dir(runs_task_dir).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !n.ends_with(".json") || n.ends_with(".proof.json") || n.ends_with(".visual-proof.json") {
            continue;
        }
        if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
            newest = Some(newest.map_or(m, |x| x.max(m)));
        }
    }
    newest
}

fn epoch_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// In-flight runs: a task whose newest session line was written within the window, and which has
/// NOT just written a completed run record (a fresh record means the run finished — show it as done).
pub fn list_active(repo_path: &Path) -> io::Result<Vec<ActiveRun>> {
    let sessions = repo_path.join(".vanguard").join("sessions");
    let runs = repo_path.join(".vanguard").join("runs");
    let now = SystemTime::now();
    let mut out = Vec::new();

    let entries = match fs::read_dir(&sessions) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };

    for task in entries.flatten() {
        if !task.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some((file, mtime)) = newest_jsonl(&task.path()) else {
            continue;
        };
        if !within(mtime, now, ACTIVE_WINDOW) {
            continue;
        }
        let task_id = task.file_name().to_string_lossy().into_owned();
        if let Some(rec) = newest_record_mtime(&runs.join(&task_id)) {
            if within(rec, now, ACTIVE_WINDOW) {
                continue; // run just finished — belongs in the completed list, not here
            }
        }
        out.push(ActiveRun {
            task_id,
            session_file: file.to_string_lossy().into_owned(),
            last_activity_ms: epoch_ms(mtime),
        });
    }

    out.sort_by(|a, b| b.last_activity_ms.cmp(&a.last_activity_ms));
    Ok(out)
}

/// Path is caller-supplied — only read Vanguard session logs
/// (`…/.vanguard/sessions/<task>/<file>.jsonl`). A substring check on "sessions"
/// would read any `.jsonl` anywhere; require the real `.vanguard/sessions` segments.
pub fn is_session_path(p: &str) -> bool {
    if p.contains("..") {
        return false;
    }
    let path = Path::new(p);
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return false;
    }
    let comps: Vec<&std::ffi::OsStr> = path.components().map(|c| c.as_os_str()).collect();
    comps
        .windows(2)
        .any(|w| w[0].to_str() == Some(".vanguard") && w[1].to_str() == Some("sessions"))
}

/// Parse a Claude session `.jsonl` into a readable stream: assistant prose + tool-invocation names.
/// Tool results, attachments and queue ops are skipped (noise for a live view).
pub fn read_session(session_file: &Path) -> io::Result<SessionRead> {
    let content = crate::runs::read_text_no_symlink(session_file)?;
    let mut entries = Vec::new();
    let mut input_tokens = 0u64;
    let mut output_tokens = 0u64;
    let mut cache_read_tokens = 0u64;
    let mut est_cost_usd = 0.0f64;
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(u) = v.pointer("/message/usage") {
            let it = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            let ot = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            let cr = u.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            input_tokens += it;
            output_tokens += ot;
            cache_read_tokens += cr;
            if let Some((pi, po, pc)) = v.pointer("/message/model").and_then(|m| m.as_str()).and_then(model_price) {
                est_cost_usd += (it as f64 * pi + ot as f64 * po + cr as f64 * pc) / 1_000_000.0;
            }
        }
        let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) else {
            continue;
        };
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        if !t.trim().is_empty() {
                            entries.push(TranscriptEntry { role: "assistant".into(), text: t.to_string() });
                        }
                    }
                }
                Some("tool_use") => {
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    entries.push(TranscriptEntry { role: "tool".into(), text: name.to_string() });
                }
                _ => {}
            }
        }
    }
    Ok(SessionRead { entries, input_tokens, output_tokens, cache_read_tokens, est_cost_usd })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_text_and_tool_uses() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("s.jsonl");
        fs::write(
            &f,
            [
                r#"{"type":"attachment","x":1}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Working on it"},{"type":"tool_use","name":"Edit","input":{}}]}}"#,
                r#"{"type":"user","message":{"content":[]},"toolUseResult":"ok"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let out = read_session(&f).unwrap().entries;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, "assistant");
        assert_eq!(out[0].text, "Working on it");
        assert_eq!(out[1].role, "tool");
        assert_eq!(out[1].text, "Edit");
    }

    #[test]
    fn estimates_cost_per_message_off_model_and_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("s.jsonl");
        fs::write(
            &f,
            [
                // opus: 1M in @ $5 + 1M out @ $25 + 1M cacheRead @ $0.5 = $30.5
                r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":1000000},"content":[{"type":"text","text":"a"}]}}"#,
                // unknown model contributes tokens but no cost (lower-bound estimate)
                r#"{"type":"assistant","message":{"model":"mystery-9","usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0},"content":[{"type":"text","text":"b"}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let r = read_session(&f).unwrap();
        assert_eq!(r.input_tokens, 2_000_000);
        assert_eq!(r.output_tokens, 1_000_000);
        assert_eq!(r.cache_read_tokens, 1_000_000);
        assert!((r.est_cost_usd - 30.5).abs() < 1e-9, "est was {}", r.est_cost_usd);
    }

    #[test]
    fn prices_openrouter_slugs_and_orders_sonnet_5_before_sonnet_4() {
        // OpenRouter echoes provider-prefixed dotted slugs; they must price like the bare ids.
        assert_eq!(model_price("anthropic/claude-opus-4.8"), Some((5.0, 25.0, 0.5)));
        assert_eq!(model_price("z-ai/glm-5.2"), Some((0.93, 3.0, 0.18)));
        // sonnet-5 keeps its cheaper introductory rate; sonnet-4.6 must NOT match the sonnet-5 arm.
        assert_eq!(model_price("anthropic/claude-sonnet-5"), Some((2.0, 10.0, 0.2)));
        assert_eq!(model_price("anthropic/claude-sonnet-4.6"), Some((3.0, 15.0, 0.3)));
        assert_eq!(model_price("mystery-9"), None);
    }

    #[test]
    fn fresh_session_is_active_no_sessions_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_active(tmp.path()).unwrap().is_empty());

        let sess = tmp.path().join(".vanguard/sessions/task-x");
        fs::create_dir_all(&sess).unwrap();
        fs::write(sess.join("a.jsonl"), "{}").unwrap(); // just written -> mtime now
        let active = list_active(tmp.path()).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].task_id, "task-x");
    }

    #[test]
    fn session_path_guard() {
        assert!(is_session_path("/repo/.vanguard/sessions/t/a.jsonl"));
        assert!(!is_session_path("/etc/passwd"));
        assert!(!is_session_path("/repo/.vanguard/sessions/../../secret.jsonl"));
        // "sessions" in the path but NOT under a real `.vanguard/sessions` dir.
        assert!(!is_session_path("/tmp/sessions/evil.jsonl"));
        assert!(!is_session_path("/repo/.vanguard/runs/t/a.jsonl"));
    }
}
