use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    /// Lifecycle column: queued | claimed | running | verify-failed | review | done.
    pub column: String,
    pub state: String,
}

/// Best-effort mapping of a Task's state/labels to a board column, following vanguard's conventions.
fn column_for(text: &str) -> &'static str {
    let t = text.to_lowercase();
    if t.contains("running") {
        "running"
    } else if t.contains("verify") || t.contains("failed") {
        "verify-failed"
    } else if t.contains("review") || t.contains("needs-human") || t.contains("needs human") {
        "review"
    } else if t.contains("done") || t.contains("closed") || t.contains("merged") || t.contains("complete") {
        "done"
    } else if t.contains("claim") || t.contains("in progress") || t.contains("in-progress") || t.contains("doing") {
        "claimed"
    } else {
        "queued"
    }
}

pub fn list_tasks(repo_path: &Path) -> Result<Vec<Task>, String> {
    let cfg = crate::appconfig::read(repo_path);
    match cfg.source.as_deref() {
        Some("linear") => list_linear(repo_path),
        Some("github") => list_github(repo_path, cfg.label.as_deref()),
        _ => Err("Set a Task Source in Settings to load the board.".into()),
    }
}

fn list_github(repo: &Path, label: Option<&str>) -> Result<Vec<Task>, String> {
    let mut args: Vec<&str> = vec!["issue", "list", "--json", "number,title,labels,state", "-L", "50", "--state", "all"];
    if let Some(l) = label {
        args.push("--label");
        args.push(l);
    }
    let out = Command::new("gh")
        .args(&args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("`gh` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`gh issue list` failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("unexpected gh output")?;
    Ok(arr
        .iter()
        .map(|i| {
            let labels: Vec<String> = i
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|a| a.iter().filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
                .unwrap_or_default();
            let state = i.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let combined = format!("{} {}", labels.join(" "), state);
            Task {
                id: i.get("number").and_then(|n| n.as_u64()).map(|n| n.to_string()).unwrap_or_default(),
                title: i.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                column: column_for(&combined).to_string(),
                state: labels.into_iter().next().unwrap_or(state),
            }
        })
        .collect())
}

fn list_linear(repo: &Path) -> Result<Vec<Task>, String> {
    let out = Command::new("linear")
        .args(["issue", "query", "--json"])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("`linear` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`linear issue query` failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let nodes = v.get("nodes").and_then(|n| n.as_array()).ok_or("unexpected linear output")?;
    Ok(nodes
        .iter()
        .map(|n| {
            let state = n.pointer("/state/name").and_then(|s| s.as_str()).unwrap_or("").to_string();
            Task {
                id: n.get("identifier").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                title: n.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                column: column_for(&state).to_string(),
                state,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn maps_states_to_columns() {
        assert_eq!(column_for("vanguard::running"), "running");
        assert_eq!(column_for("In Review"), "review");
        assert_eq!(column_for("verify-failed"), "verify-failed");
        assert_eq!(column_for("Done"), "done");
        assert_eq!(column_for("In Progress"), "claimed");
        assert_eq!(column_for("Todo"), "queued");
    }

    #[test]
    fn no_source_errors() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_tasks(&PathBuf::from(tmp.path())).is_err());
    }
}
