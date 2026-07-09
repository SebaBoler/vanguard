use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Canonical Vanguard taskId (`gh-<n>` / `gl-<iid>` / `linear-<id>`) — the same scheme the
    /// runners mint, so a card resolves for spec fetch and matches run-record taskIds. NOT the raw
    /// provider number (which `taskid::resolve` rejects).
    pub id: String,
    pub title: String,
    /// Lifecycle column: queued | claimed | running | verify-failed | review | done.
    pub column: String,
    pub state: String,
}

/// Best-effort mapping of a Task's state/labels to a board column, following Vanguard's real label
/// vocabulary (`github-labels.ts` / `gitlab-labels.ts`): `vanguard:running`, `vanguard::verify-failed`,
/// `vanguard:speccing`, `vanguard::secret-blocked`, plus Linear states (`Speccing`, `In Progress`, …).
/// Order matters — the most specific terminal states are checked first.
fn column_for(text: &str) -> &'static str {
    let t = text.to_lowercase();
    if t.contains("running") {
        "running"
    } else if t.contains("verify") || t.contains("failed") || t.contains("blocked") {
        "verify-failed"
    } else if t.contains("review") || t.contains("needs-human") || t.contains("needs human") {
        "review"
    } else if t.contains("done") || t.contains("closed") || t.contains("merged") || t.contains("complete") {
        "done"
    } else if t.contains("spec")
        || t.contains("claim")
        || t.contains("in progress")
        || t.contains("in-progress")
        || t.contains("doing")
    {
        "claimed"
    } else {
        "queued"
    }
}

pub fn list_tasks(repo_path: &Path) -> Result<Vec<Task>, String> {
    let cfg = crate::appconfig::read(repo_path);
    match cfg.source.as_deref() {
        Some("linear") => list_linear(repo_path, cfg.team.as_deref()),
        Some("github") => list_github(repo_path, cfg.label.as_deref()),
        Some("gitlab") => list_gitlab(repo_path, cfg.label.as_deref()),
        _ => Err("Set a Task Source in Settings to load the board.".into()),
    }
}

/// A label value from provider JSON — GitHub/Linear give objects (`{"name":…}`), glab gives bare
/// strings. Accept either so the board doesn't silently drop labels on the provider that differs.
fn label_name(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .map(String::from)
        .or_else(|| v.get("name").and_then(|n| n.as_str()).map(String::from))
}

fn labels_of(i: &serde_json::Value) -> Vec<String> {
    i.get("labels")
        .and_then(|l| l.as_array())
        .map(|a| a.iter().filter_map(label_name).collect())
        .unwrap_or_default()
}

fn task_from_github(i: &serde_json::Value) -> Task {
    let labels = labels_of(i);
    let state = i.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let combined = format!("{} {}", labels.join(" "), state);
    let id = i
        .get("number")
        .and_then(|n| n.as_u64())
        .map(|n| format!("gh-{n}"))
        .unwrap_or_default();
    Task {
        id,
        title: i.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        column: column_for(&combined).to_string(),
        state: labels.into_iter().next().unwrap_or(state),
    }
}

fn task_from_gitlab(i: &serde_json::Value) -> Task {
    let labels = labels_of(i);
    let state = i.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let combined = format!("{} {}", labels.join(" "), state);
    let id = i
        .get("iid")
        .and_then(|n| n.as_u64())
        .map(|n| format!("gl-{n}"))
        .unwrap_or_default();
    Task {
        id,
        title: i.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        column: column_for(&combined).to_string(),
        state: labels.into_iter().next().unwrap_or(state),
    }
}

fn task_from_linear(n: &serde_json::Value) -> Task {
    let state = n.pointer("/state/name").and_then(|s| s.as_str()).unwrap_or("").to_string();
    // Fold both the workflow state (Linear's lifecycle) and any vanguard::/vanguard: labels into the
    // column decision; display the workflow state as the chip.
    let labels: Vec<String> = n
        .pointer("/labels/nodes")
        .and_then(|l| l.as_array())
        .map(|a| a.iter().filter_map(label_name).collect())
        .unwrap_or_default();
    let combined = format!("{} {}", labels.join(" "), state);
    // Mint the same id the linear runner does: `linear-<identifier lowercased>`.
    let id = n
        .get("identifier")
        .and_then(|x| x.as_str())
        .map(|x| format!("linear-{}", x.to_lowercase()))
        .unwrap_or_default();
    Task {
        id,
        title: n.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        column: column_for(&combined).to_string(),
        state,
    }
}

fn run_json(repo: &Path, bin: &str, args: &[&str]) -> Result<serde_json::Value, String> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("`{bin}` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`{bin} {}` failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

fn list_github(repo: &Path, label: Option<&str>) -> Result<Vec<Task>, String> {
    let mut args: Vec<&str> = vec!["issue", "list", "--json", "number,title,labels,state", "-L", "50", "--state", "all"];
    if let Some(l) = label {
        args.push("--label");
        args.push(l);
    }
    let v = run_json(repo, "gh", &args)?;
    let arr = v.as_array().ok_or("unexpected gh output")?;
    Ok(arr.iter().map(task_from_github).collect())
}

fn list_gitlab(repo: &Path, label: Option<&str>) -> Result<Vec<Task>, String> {
    let mut args: Vec<&str> = vec!["issue", "list", "-P", "50", "-F", "json"];
    if let Some(l) = label {
        args.push("--label");
        args.push(l);
    }
    let v = run_json(repo, "glab", &args)?;
    let arr = v.as_array().ok_or("unexpected glab output")?;
    Ok(arr.iter().map(task_from_gitlab).collect())
}

/// Reuse the `linear` CLI's stored login (`linear auth login`) rather than a separate LINEAR_API_KEY:
/// `linear auth token` prints the configured token. Keeps board auth identical to spec fetch — one
/// credential, no new setup.
fn linear_token(repo: &Path) -> Result<String, String> {
    let out = Command::new("linear")
        .args(["auth", "token"])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("`linear` not available: {e}"))?;
    if !out.status.success() {
        return Err("Not logged in to Linear — run `linear auth login`.".into());
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err("`linear auth token` returned nothing — run `linear auth login`.".into());
    }
    Ok(token)
}

fn linear_graphql(token: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build();
    let resp = agent
        .post("https://api.linear.app/graphql")
        .set("Authorization", token)
        .set("Content-Type", "application/json")
        .send_string(&body_str)
        .map_err(|e| format!("Linear API request failed: {e}"))?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(errs) = v.get("errors").filter(|e| !e.is_null()) {
        return Err(format!("Linear API error: {errs}"));
    }
    Ok(v)
}

fn tasks_from_linear_graphql(v: &serde_json::Value) -> Vec<Task> {
    v.pointer("/data/issues/nodes")
        .and_then(|n| n.as_array())
        .map(|arr| arr.iter().map(task_from_linear).collect())
        .unwrap_or_default()
}

/// The schpet `linear` CLI (README §Linear) dropped a JSON issue *list* — `issue list` is human-only
/// and truncates titles/labels. Go straight to Linear's GraphQL API for the board, reusing the CLI's
/// stored token. Scoped to one team (a repo maps to a team, not a workspace); `issue view --json`
/// still handles single-spec fetch in spec.rs.
fn list_linear(repo: &Path, team: Option<&str>) -> Result<Vec<Task>, String> {
    let team = team.ok_or("Set a Linear team key (e.g. DEV) in Settings to load the board.")?;
    let token = linear_token(repo)?;
    let body = serde_json::json!({
        "query": "query($f: IssueFilter) { issues(first: 50, filter: $f) { nodes { identifier title state { name } labels { nodes { name } } } } }",
        "variables": { "f": { "team": { "key": { "eq": team } } } }
    });
    let v = linear_graphql(&token, &body)?;
    Ok(tasks_from_linear_graphql(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn maps_states_to_columns() {
        // Real label/state vocabulary from github-labels.ts / gitlab-labels.ts + Linear states.
        assert_eq!(column_for("vanguard:running"), "running");
        assert_eq!(column_for("vanguard:needs-human-review"), "review");
        assert_eq!(column_for("vanguard::verify-failed"), "verify-failed");
        assert_eq!(column_for("vanguard::secret-blocked"), "verify-failed");
        assert_eq!(column_for("vanguard:speccing"), "claimed");
        assert_eq!(column_for("Speccing"), "claimed");
        assert_eq!(column_for("Done"), "done");
        assert_eq!(column_for("closed"), "done");
        assert_eq!(column_for("In Progress"), "claimed");
        assert_eq!(column_for("Todo"), "queued");
    }

    #[test]
    fn github_task_mints_resolvable_id() {
        let item = serde_json::json!({
            "number": 904, "title": "Fix widget", "state": "open",
            "labels": [{"name": "vanguard:running"}]
        });
        let t = task_from_github(&item);
        assert_eq!(t.id, "gh-904");
        // The minted id must resolve back to (github, 904) — the spec-fetch path depends on it.
        let r = crate::taskid::resolve(&t.id).unwrap();
        assert_eq!(r.source, "github");
        assert_eq!(r.reference, "904");
        assert_eq!(t.column, "running");
    }

    #[test]
    fn gitlab_task_mints_resolvable_id() {
        // glab list emits bare-string labels, not objects.
        let item = serde_json::json!({
            "iid": 5, "title": "MR thing", "state": "opened",
            "labels": ["vanguard::verify-failed"]
        });
        let t = task_from_gitlab(&item);
        assert_eq!(t.id, "gl-5");
        assert_eq!(crate::taskid::resolve(&t.id).unwrap().source, "gitlab");
        assert_eq!(t.column, "verify-failed");
        assert_eq!(t.state, "vanguard::verify-failed");
    }

    #[test]
    fn linear_task_mints_resolvable_id() {
        let node = serde_json::json!({
            "identifier": "DEV-639", "title": "Ship it",
            "state": {"name": "In Progress"}, "labels": {"nodes": []}
        });
        let t = task_from_linear(&node);
        assert_eq!(t.id, "linear-dev-639");
        assert_eq!(crate::taskid::resolve(&t.id).unwrap().reference, "DEV-639");
        assert_eq!(t.column, "claimed");
        assert_eq!(t.state, "In Progress"); // workflow state shown as the chip
    }

    #[test]
    fn linear_label_overrides_state_for_column() {
        // A vanguard lifecycle label must win over the workflow state for the column.
        let node = serde_json::json!({
            "identifier": "DEV-700", "title": "Broke verify",
            "state": {"name": "In Progress"},
            "labels": {"nodes": [{"name": "vanguard::verify-failed"}]}
        });
        assert_eq!(task_from_linear(&node).column, "verify-failed");
    }

    #[test]
    fn linear_graphql_parses_nodes() {
        // Shape returned by the Linear GraphQL API (data.issues.nodes[]).
        let resp = serde_json::json!({
            "data": {"issues": {"nodes": [
                {"identifier": "DEV-1", "title": "A", "state": {"name": "Done"}, "labels": {"nodes": []}},
                {"identifier": "DEV-2", "title": "B", "state": {"name": "Todo"}, "labels": {"nodes": []}}
            ]}}
        });
        let tasks = tasks_from_linear_graphql(&resp);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "linear-dev-1");
        assert_eq!(tasks[0].column, "done");
        assert_eq!(tasks[1].column, "queued");
    }

    #[test]
    fn no_source_errors() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_tasks(&PathBuf::from(tmp.path())).is_err());
    }

    #[test]
    fn linear_board_needs_a_team() {
        // Linear source with no team key → actionable error, no network call.
        let tmp = tempfile::tempdir().unwrap();
        let err = list_linear(tmp.path(), None).unwrap_err();
        assert!(err.contains("team key"), "{err}");
    }

    // Live smoke: hits the real Linear GraphQL API using the local `linear auth token` + a real team.
    // Ignored so CI (no creds / no network) skips it. Run locally:
    //   LINEAR_SMOKE_TEAM=DEV cargo test -- --ignored linear_graphql_live
    #[test]
    #[ignore]
    fn linear_graphql_live() {
        let team = std::env::var("LINEAR_SMOKE_TEAM").expect("set LINEAR_SMOKE_TEAM to a team key");
        let tasks = list_linear(&PathBuf::from("."), Some(&team)).expect("live linear list");
        assert!(!tasks.is_empty(), "expected at least one issue for team {team}");
        assert!(tasks.iter().all(|t| t.id.starts_with("linear-")));
    }
}
