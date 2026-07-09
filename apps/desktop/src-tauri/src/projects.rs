use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use crate::runs::RunSummary;

/// Parsed run summaries per repo, reused across dashboard polls while the runs tree is unchanged.
/// `list_run_summaries` reads + JSON-parses every run record; without this the whole history is
/// re-parsed for every project on each poll (`App.tsx` ticks `listProjects()` every 5s). Keyed by
/// repo path; the tree fingerprint invalidates it when a record is added, removed, or rewritten.
/// ponytail: `list_active` still stat-scans session dirs each tick, but that's stat-only (no reads)
/// and its result is time-sensitive anyway; only the heavy parse is worth caching.
/// Per-repo cache entry: (runs-tree fingerprint, parsed summaries at that fingerprint).
type SummaryCache = HashMap<String, (u64, Vec<RunSummary>)>;

fn summaries_cache() -> &'static Mutex<SummaryCache> {
    static CACHE: OnceLock<Mutex<SummaryCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_summaries(repo_path: &Path) -> Vec<RunSummary> {
    let key = repo_path.to_string_lossy().into_owned();
    let fp = crate::runs::runs_fingerprint(repo_path);
    if let Some((cached_fp, summaries)) = summaries_cache().lock().unwrap().get(&key) {
        if *cached_fp == fp {
            return summaries.clone();
        }
    }
    // Only cache a successful parse. Caching a transient error's empty result would pin the dashboard
    // at 0 runs until the tree fingerprint next shifts; returning the default un-cached self-heals on
    // the next poll instead.
    match crate::runs::list_run_summaries(repo_path) {
        Ok(summaries) => {
            summaries_cache().lock().unwrap().insert(key, (fp, summaries.clone()));
            summaries
        }
        Err(_) => Vec::new(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub run_count: usize,
    pub task_count: usize,
    pub total_cost_usd: f64,
    pub failed_count: usize,
    pub last_run: Option<String>,
    /// In-flight runs right now (from active sessions).
    pub running_count: usize,
    /// Completed runs whose timestamp is within the last 24h (velocity).
    pub runs_last_24h: usize,
    /// Configured per-project color (`#rrggbb`), or None → the UI derives one from the path.
    pub color: Option<String>,
}

fn projects_file(config_dir: &Path) -> PathBuf {
    config_dir.join("projects.json")
}

/// The persisted project list is just an array of repo paths; metrics are recomputed on read.
pub fn load_paths(config_dir: &Path) -> io::Result<Vec<String>> {
    match fs::read_to_string(projects_file(config_dir)) {
        // Surface a corrupt store as an error — do NOT default to empty, or the next
        // add/remove would save_paths over it and wipe the user's whole project list.
        Ok(s) => serde_json::from_str(&s).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

pub fn save_paths(config_dir: &Path, paths: &[String]) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(paths).map_err(io::Error::other)?;
    fs::write(projects_file(config_dir), json)
}

/// Aggregate a repo's `.vanguard/runs` into a dashboard summary (+ live running count).
pub fn aggregate(repo_path: &Path) -> Project {
    aggregate_at(repo_path, Utc::now())
}

fn aggregate_at(repo_path: &Path, now: DateTime<Utc>) -> Project {
    let name = repo_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_path.to_string_lossy().into_owned());
    let summaries = cached_summaries(repo_path);
    let cutoff = now - Duration::hours(24);

    let mut tasks = BTreeSet::new();
    let mut total_cost_usd = 0.0;
    let mut failed_count = 0;
    let mut runs_last_24h = 0;
    let mut last_run: Option<String> = None;
    for s in &summaries {
        tasks.insert(s.task_id.clone());
        total_cost_usd += s.total_cost_usd;
        if s.any_failed {
            failed_count += 1;
        }
        if last_run.as_deref().is_none_or(|l| s.timestamp.as_str() > l) {
            last_run = Some(s.timestamp.clone());
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(&s.timestamp) {
            if dt.with_timezone(&Utc) >= cutoff {
                runs_last_24h += 1;
            }
        }
    }

    let running_count = crate::active::list_active(repo_path).map(|a| a.len()).unwrap_or(0);

    Project {
        path: repo_path.to_string_lossy().into_owned(),
        name,
        run_count: summaries.len(),
        task_count: tasks.len(),
        total_cost_usd,
        failed_count,
        last_run,
        running_count,
        runs_last_24h,
        color: crate::appconfig::read(repo_path).color,
    }
}

pub fn list(config_dir: &Path) -> io::Result<Vec<Project>> {
    Ok(load_paths(config_dir)?
        .iter()
        .map(|p| aggregate(Path::new(p)))
        .collect())
}

pub fn add(config_dir: &Path, path: &str) -> io::Result<Vec<Project>> {
    let mut paths = load_paths(config_dir)?;
    if !paths.iter().any(|p| p == path) {
        paths.push(path.to_string());
    }
    save_paths(config_dir, &paths)?;
    list(config_dir)
}

pub fn remove(config_dir: &Path, path: &str) -> io::Result<Vec<Project>> {
    let paths: Vec<String> = load_paths(config_dir)?
        .into_iter()
        .filter(|p| p != path)
        .collect();
    save_paths(config_dir, &paths)?;
    list(config_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_run_repo(repo: &Path) {
        let f = repo.join(".vanguard/runs/task-1/2026-07-06T19-12-02-123Z-implement.json");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(
            &f,
            r#"{"taskId":"task-1","completed":true,"exitReason":"completed","turns":3,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"ok",
                "costUsd":0.10,"timestamp":"2026-07-06T19:12:02.123Z","stage":"implement"}"#,
        )
        .unwrap();
    }

    #[test]
    fn aggregate_counts_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj-a");
        one_run_repo(&repo);
        // Fixed "now" ~48m after the fixture run so the 24h velocity window is deterministic.
        let now = DateTime::parse_from_rfc3339("2026-07-06T20:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let p = aggregate_at(&repo, now);
        assert_eq!(p.name, "proj-a");
        assert_eq!(p.run_count, 1);
        assert_eq!(p.task_count, 1);
        assert!((p.total_cost_usd - 0.10).abs() < 1e-9);
        assert_eq!(p.failed_count, 0);
        assert_eq!(p.last_run.as_deref(), Some("2026-07-06T19:12:02.123Z"));
        assert_eq!(p.running_count, 0);
        assert_eq!(p.runs_last_24h, 1);
    }

    #[test]
    fn add_list_remove_roundtrip() {
        let cfg = tempfile::tempdir().unwrap();
        let repo_tmp = tempfile::tempdir().unwrap();
        let repo = repo_tmp.path().join("proj-a");
        one_run_repo(&repo);
        let repo_str = repo.to_string_lossy().into_owned();

        let after_add = add(cfg.path(), &repo_str).unwrap();
        assert_eq!(after_add.len(), 1);
        assert_eq!(after_add[0].run_count, 1);

        // dedup: adding the same path again keeps a single entry
        assert_eq!(add(cfg.path(), &repo_str).unwrap().len(), 1);

        let after_remove = remove(cfg.path(), &repo_str).unwrap();
        assert!(after_remove.is_empty());
    }

    #[test]
    fn missing_store_lists_empty() {
        let cfg = tempfile::tempdir().unwrap();
        assert!(list(cfg.path()).unwrap().is_empty());
    }

    #[test]
    fn cache_invalidates_when_a_run_is_added() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("proj-cache");
        one_run_repo(&repo);
        // First aggregate populates the summaries cache for this repo path.
        assert_eq!(aggregate(&repo).run_count, 1);
        // A second run under a new task dir must shift the fingerprint and bust the cache.
        let f = repo.join(".vanguard/runs/task-2/2026-07-06T20-00-00-000Z-implement.json");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(
            &f,
            r#"{"taskId":"task-2","completed":true,"exitReason":"completed","turns":1,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"ok",
                "costUsd":0.20,"timestamp":"2026-07-06T20:00:00.000Z","stage":"implement"}"#,
        )
        .unwrap();
        assert_eq!(aggregate(&repo).run_count, 2);
    }

    #[test]
    fn corrupt_store_errors_and_does_not_wipe() {
        let cfg = tempfile::tempdir().unwrap();
        let store = projects_file(cfg.path());
        fs::write(&store, "{ not valid json").unwrap();
        // load errors instead of defaulting to empty...
        assert!(load_paths(cfg.path()).is_err());
        // ...and a failed add leaves the original bytes intact (no overwrite/wipe).
        assert!(add(cfg.path(), "/some/repo").is_err());
        assert_eq!(fs::read_to_string(&store).unwrap(), "{ not valid json");
    }
}
