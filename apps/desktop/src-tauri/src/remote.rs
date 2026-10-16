use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::runs::{self, RunSummary};

/// Artifact name the factory workflows upload `.vanguard/runs/` under (`upload-run-records`).
const ARTIFACT: &str = "vanguard-runs";

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
    /// The run's record artifact is already in the local cache (no `gh` needed to open it).
    pub cached: bool,
}

/// A CI run's downloaded record tree, parsed like a local repo's `.vanguard/runs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecords {
    /// Cache dir laid out like a repo (`<cache_path>/.vanguard/runs/…`), so the renderer passes it
    /// to `read_run` as `repo_path` and gets the same RunDetail as for a local run.
    pub cache_path: String,
    pub runs: Vec<RunSummary>,
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
            cached: false,
        })
        .collect())
}

/// `owner-repo` from a GitHub remote URL (ssh or https). Only `[A-Za-z0-9_-]` survive, so the
/// result is always a single safe path segment (no `/`, no `..`).
fn slug_from_remote(url: &str) -> Option<String> {
    let rest = &url[url.find("github.com")? + "github.com".len()..];
    let rest = rest.trim_start_matches([':', '/']).trim_end_matches('/').trim_end_matches(".git");
    if rest.is_empty() {
        return None;
    }
    Some(rest.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect())
}

/// Cache key for a repo: its `origin` slug, else the directory name.
fn repo_slug(repo_path: &Path) -> String {
    Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| slug_from_remote(String::from_utf8_lossy(&o.stdout).trim()))
        .or_else(|| repo_path.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "repo".into())
}

/// `<cache_root>/remote-runs/<slug>/<run_id>` — a fake repo root whose `.vanguard/runs` is the
/// downloaded artifact, so runs.rs reads it unchanged.
fn cache_repo_dir(cache_root: &Path, slug: &str, run_id: u64) -> PathBuf {
    cache_root.join("remote-runs").join(slug).join(run_id.to_string())
}

fn is_cached(cache_repo: &Path) -> bool {
    fs::read_dir(runs::runs_dir(cache_repo)).map(|mut d| d.next().is_some()).unwrap_or(false)
}

fn download_args(run_id: u64, dest: &Path) -> Vec<String> {
    ["run", "download", &run_id.to_string(), "-n", ARTIFACT, "-D", &dest.to_string_lossy()]
        .map(String::from)
        .to_vec()
}

/// List recent CI runs for a repo via `gh run list` (GitHub Actions). Best-effort: requires an
/// authed `gh` in a GitHub repo; returns a clear error otherwise (spec §14 — the runs-list slice).
pub fn list_remote_runs(cache_root: &Path, repo_path: &Path) -> Result<Vec<RemoteRun>, String> {
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
    let mut runs = parse_runs(&out.stdout)?;
    let slug = repo_slug(repo_path);
    for r in &mut runs {
        r.cached = is_cached(&cache_repo_dir(cache_root, &slug, r.id));
    }
    Ok(runs)
}

fn fetch_artifact(repo_path: &Path, run_id: u64, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // A single `-n` makes gh extract straight into `-D`; upload-artifact strips the `.vanguard/runs/`
    // prefix, so `<dest>/<taskId>/<record>.json` lands exactly where runs.rs looks.
    let out = Command::new("gh")
        .args(download_args(run_id, dest))
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("`gh` not available: {e}"))?;
    if !out.status.success() {
        return Err(format!("`gh run download` failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Pull a CI run's `vanguard-runs` artifact into the cache (once; cached runs skip `gh`) and group
/// it into the same run summaries the local Runs table uses. Best-effort like `list_remote_runs`:
/// `gh` missing / unauthenticated / no such artifact come back as the tool's own message.
pub fn download_run_records(cache_root: &Path, repo_path: &Path, run_id: u64) -> Result<RemoteRecords, String> {
    let cache_repo = cache_repo_dir(cache_root, &repo_slug(repo_path), run_id);
    if !is_cached(&cache_repo) {
        if let Err(e) = fetch_artifact(repo_path, run_id, &runs::runs_dir(&cache_repo)) {
            let _ = fs::remove_dir_all(&cache_repo); // no half-written cache → no false "cached" marker
            return Err(e);
        }
    }
    let runs = runs::list_run_summaries(&cache_repo).map_err(|e| e.to_string())?;
    Ok(RemoteRecords { cache_path: cache_repo.to_string_lossy().into_owned(), runs })
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
        assert!(!runs[0].cached);
    }

    #[test]
    fn cache_path_and_gh_download_argv() {
        let repo = cache_repo_dir(Path::new("/cfg"), "SebaBoler-vanguard", 42);
        assert_eq!(repo, Path::new("/cfg/remote-runs/SebaBoler-vanguard/42"));
        let dest = runs::runs_dir(&repo);
        assert_eq!(dest, Path::new("/cfg/remote-runs/SebaBoler-vanguard/42/.vanguard/runs"));
        assert_eq!(
            download_args(42, &dest),
            ["run", "download", "42", "-n", "vanguard-runs", "-D", "/cfg/remote-runs/SebaBoler-vanguard/42/.vanguard/runs"]
        );
    }

    #[test]
    fn slug_from_ssh_and_https_remotes_is_one_safe_segment() {
        assert_eq!(slug_from_remote("git@github.com:SebaBoler/vanguard.git").as_deref(), Some("SebaBoler-vanguard"));
        assert_eq!(slug_from_remote("https://github.com/SebaBoler/vanguard").as_deref(), Some("SebaBoler-vanguard"));
        assert_eq!(slug_from_remote("https://github.com/o/r.git/").as_deref(), Some("o-r"));
        assert_eq!(slug_from_remote("https://github.com/../x").as_deref(), Some("---x"));
        assert_eq!(slug_from_remote("https://gitlab.com/o/r"), None);
        assert_eq!(slug_from_remote("https://github.com/"), None);
    }

    fn write_record(cache_repo: &Path) {
        let f = runs::runs_dir(cache_repo).join("task-9/2026-07-06T19-12-02-123Z-implement.json");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(
            &f,
            r#"{"taskId":"task-9","completed":true,"exitReason":"completed","turns":3,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"ok",
                "costUsd":0.10,"timestamp":"2026-07-06T19:12:02.123Z","stage":"implement"}"#,
        )
        .unwrap();
    }

    #[test]
    fn cached_only_once_records_are_present() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = cache_repo_dir(tmp.path(), "s", 1);
        assert!(!is_cached(&repo));
        fs::create_dir_all(runs::runs_dir(&repo)).unwrap();
        assert!(!is_cached(&repo)); // empty dir (aborted download) is not a cache hit
        write_record(&repo);
        assert!(is_cached(&repo));
    }

    #[test]
    fn cached_records_are_read_without_gh() {
        // `repo` is not a git repo, so a `gh run download` here would fail; the cache hit must skip it.
        let cache = tempfile::tempdir().unwrap();
        let repo_tmp = tempfile::tempdir().unwrap();
        let repo = repo_tmp.path().join("proj-a");
        fs::create_dir_all(&repo).unwrap();
        let cache_repo = cache_repo_dir(cache.path(), "proj-a", 7);
        write_record(&cache_repo);
        let out = download_run_records(cache.path(), &repo, 7).unwrap();
        assert_eq!(out.cache_path, cache_repo.to_string_lossy());
        assert_eq!(out.runs.len(), 1);
        assert_eq!(out.runs[0].task_id, "task-9");
    }
}
