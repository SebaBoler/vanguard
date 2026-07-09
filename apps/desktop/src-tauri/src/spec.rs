use std::path::Path;
use std::process::Command;

fn run_cli(cwd: &Path, bin: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("`{bin}` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`{bin}` failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn title_body(json: &str, body_key: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("");
    let body = v.get(body_key).and_then(|b| b.as_str()).unwrap_or("");
    Ok(format!("# {title}\n\n{body}").trim().to_string())
}

/// Best-effort fetch of a Task's source spec, inferring the Task Source from the task id:
/// `linear-*` → Linear (`linear` CLI), all-numeric → GitHub (`gh` CLI). Runs in the repo dir so
/// the runner detects the project; auth is the operator's env. Falls back to a clear error.
pub fn fetch_spec(repo_path: &Path, task_id: &str) -> Result<String, String> {
    let Some(resolved) = crate::taskid::resolve(task_id) else {
        return Err(format!(
            "Couldn't resolve a Task Source from task id `{task_id}`. Recognized prefixes: `gh-` (GitHub), `gl-` (GitLab), `linear-` (Linear)."
        ));
    };
    // GitHub/GitLab refs are trailing digits (flag-safe); guard the Linear identifier.
    match resolved.source.as_str() {
        "linear" => {
            let id = &resolved.reference;
            if id.starts_with('-') || !id.contains('-') || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Err(format!("Invalid Linear id in task `{task_id}`."));
            }
            let json = run_cli(repo_path, "linear", &["issue", "view", id, "--json"])?;
            title_body(&json, "description")
        }
        "github" => {
            let json = run_cli(repo_path, "gh", &["issue", "view", &resolved.reference, "--json", "title,body"])?;
            title_body(&json, "body")
        }
        "gitlab" => {
            let json = run_cli(repo_path, "glab", &["issue", "view", &resolved.reference, "-F", "json"])?;
            title_body(&json, "description")
        }
        other => Err(format!("Unsupported Task Source `{other}`.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_title_and_body() {
        let json = r#"{"title":"Fix the widget","description":"It is broken.\n- step 1"}"#;
        let out = title_body(json, "description").unwrap();
        assert!(out.starts_with("# Fix the widget"));
        assert!(out.contains("It is broken."));
    }

    #[test]
    fn rejects_flag_smuggling_linear_id() {
        // `linear--version` -> id `-VERSION` (flag-like) must be rejected before shelling out.
        let err = fetch_spec(&PathBuf::from("/nonexistent"), "linear--version").unwrap_err();
        assert!(err.contains("Invalid Linear id"));
    }

    #[test]
    fn errors_on_uninferrable_task_id() {
        // A non-linear, non-numeric id must not shell out — it returns the guidance error.
        let err = fetch_spec(&PathBuf::from("/nonexistent"), "owner/repo#weird").unwrap_err();
        assert!(err.contains("Couldn't resolve"));
    }
}
