use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRun {
    pub id: u64,
    pub status: String,
    pub conclusion: String,
    pub title: String,
    pub branch: String,
    pub workflow: String,
    pub created_at: String,
    pub event: String,
    pub url: String,
}

fn str_of(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn parse_runs(json: &[u8]) -> Result<Vec<RemoteRun>, String> {
    let v: serde_json::Value = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("unexpected gh output")?;
    Ok(arr
        .iter()
        .map(|r| RemoteRun {
            id: r.get("databaseId").and_then(|x| x.as_u64()).unwrap_or(0),
            status: str_of(r, "status"),
            conclusion: str_of(r, "conclusion"),
            title: str_of(r, "displayTitle"),
            branch: str_of(r, "headBranch"),
            workflow: str_of(r, "workflowName"),
            created_at: str_of(r, "createdAt"),
            event: str_of(r, "event"),
            url: str_of(r, "url"),
        })
        .collect())
}

/// List recent CI runs for a repo via `gh run list` (GitHub Actions). Best-effort: requires an
/// authed `gh` in a GitHub repo; returns a clear error otherwise (spec §14 — the runs-list slice).
pub fn list_remote_runs(repo_path: &Path) -> Result<Vec<RemoteRun>, String> {
    let out = Command::new("gh")
        .args([
            "run",
            "list",
            "-L",
            "30",
            "--json",
            "databaseId,status,conclusion,displayTitle,headBranch,workflowName,createdAt,event,url",
        ])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("`gh` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`gh run list` failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    parse_runs(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_run_list() {
        let json = br#"[
          {"databaseId":28816699455,"status":"completed","conclusion":"success",
           "displayTitle":"fix: thing","headBranch":"feat/x","workflowName":"CI",
           "createdAt":"2026-07-06T19:12:02Z","event":"pull_request","url":"https://gh/run/1"}
        ]"#;
        let runs = parse_runs(json).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, 28816699455);
        assert_eq!(runs[0].conclusion, "success");
        assert_eq!(runs[0].workflow, "CI");
        assert_eq!(runs[0].branch, "feat/x");
    }
}
