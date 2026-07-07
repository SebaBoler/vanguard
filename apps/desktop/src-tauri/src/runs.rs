use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub task_id: String,
    pub completed: bool,
    pub exit_reason: String,
    pub turns: u32,
    pub session_id: Option<String>,
    pub worktree_path: String,
    pub worktree_preserved: bool,
    pub final_text: String,
    pub usage: Option<AgentUsage>,
    pub cost_usd: Option<f64>,
    pub cache_efficiency: Option<f64>,
    pub duration_ms: Option<f64>,
    pub model: Option<String>,
    pub timestamp: String,
    pub stage: Option<String>,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub command: String,
    pub exit_code: i32,
    pub passed: bool,
    pub sha256: String,
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub task_id: String,
    pub timestamp: String,
    pub stages: Vec<String>,
    pub total_cost_usd: f64,
    pub any_failed: bool,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDetail {
    pub record: RunRecord,
    pub diff: Option<String>,
    pub transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub task_id: String,
    pub timestamp: String,
    pub stages: Vec<StageDetail>,
    pub proof: Option<Proof>,
}

fn runs_dir(repo_path: &Path) -> std::path::PathBuf {
    repo_path.join(".vanguard").join("runs")
}

/// Mirror of Vanguard's `timestamp.replace(/[^0-9A-Za-z]/g, '-')`.
pub fn sanitize_timestamp(ts: &str) -> String {
    ts.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Guard against path traversal: a task id must name a single direct child of the runs dir.
fn is_safe_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && !task_id.contains('/')
        && !task_id.contains('\\')
        && !task_id.contains("..")
        && !Path::new(task_id).is_absolute()
}

fn is_run_record_file(name: &str) -> bool {
    name.ends_with(".json")
        && !name.ends_with(".proof.json")
        && !name.ends_with(".visual-proof.json")
}

pub fn list_run_summaries(repo_path: &Path) -> io::Result<Vec<RunSummary>> {
    let runs = runs_dir(repo_path);
    let mut summaries: Vec<RunSummary> = Vec::new();

    let task_dirs = match fs::read_dir(&runs) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(summaries),
        Err(e) => return Err(e),
    };

    for task_entry in task_dirs {
        let task_entry = task_entry?;
        if !task_entry.file_type()?.is_dir() {
            continue;
        }
        let mut groups: BTreeMap<String, Vec<RunRecord>> = BTreeMap::new();
        for file in fs::read_dir(task_entry.path())? {
            let file = file?;
            let name = file.file_name().to_string_lossy().into_owned();
            if !is_run_record_file(&name) {
                continue;
            }
            let contents = fs::read_to_string(file.path())?;
            if let Ok(record) = serde_json::from_str::<RunRecord>(&contents) {
                groups.entry(record.timestamp.clone()).or_default().push(record);
            }
        }
        for (timestamp, records) in groups {
            let mut stages: Vec<String> = records
                .iter()
                .map(|r| r.stage.clone().unwrap_or_else(|| "run".to_string()))
                .collect();
            stages.sort();
            summaries.push(RunSummary {
                task_id: records[0].task_id.clone(),
                timestamp,
                stages,
                total_cost_usd: records.iter().filter_map(|r| r.cost_usd).sum(),
                any_failed: records.iter().any(|r| !r.completed),
                pr_url: records.iter().find_map(|r| r.pr_url.clone()),
            });
        }
    }

    summaries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(summaries)
}

pub fn read_run_detail(repo_path: &Path, task_id: &str, timestamp: &str) -> io::Result<RunDetail> {
    if !is_safe_task_id(task_id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid task id"));
    }
    let task_dir = runs_dir(repo_path).join(task_id);
    let mut stages: Vec<StageDetail> = Vec::new();

    for file in fs::read_dir(&task_dir)? {
        let file = file?;
        let name = file.file_name().to_string_lossy().into_owned();
        if !is_run_record_file(&name) {
            continue;
        }
        let path = file.path();
        let contents = fs::read_to_string(&path)?;
        let record: RunRecord = match serde_json::from_str(&contents) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if record.timestamp != timestamp {
            continue;
        }
        let path_str = path.to_string_lossy();
        let base = path_str.strip_suffix(".json").unwrap_or(&path_str);
        let diff = fs::read_to_string(format!("{base}.diff")).ok();
        let transcript = fs::read_to_string(format!("{base}.transcript.log")).ok();
        stages.push(StageDetail { record, diff, transcript });
    }

    stages.sort_by(|a, b| a.record.stage.cmp(&b.record.stage));

    let proof_path = task_dir.join(format!("{}.proof.json", sanitize_timestamp(timestamp)));
    let proof = fs::read_to_string(&proof_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Proof>(&c).ok());

    Ok(RunDetail {
        task_id: task_id.to_string(),
        timestamp: timestamp.to_string(),
        stages,
        proof,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn fixture(repo: &Path) {
        let dir = repo.join(".vanguard/runs/task-7");
        write(
            &dir.join("2026-07-06T19-12-02-123Z-implement.json"),
            r#"{"taskId":"task-7","completed":true,"exitReason":"completed","turns":12,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"did it",
                "usage":{"inputTokens":1000,"outputTokens":500,"cacheReadInputTokens":800},
                "costUsd":0.12,"cacheEfficiency":0.44,"durationMs":8123,"model":"claude-opus-4",
                "timestamp":"2026-07-06T19:12:02.123Z","stage":"implement","prUrl":"http://pr/1"}"#,
        );
        write(
            &dir.join("2026-07-06T19-12-02-123Z-review.json"),
            r#"{"taskId":"task-7","completed":true,"exitReason":"completed","turns":4,
                "worktreePath":"/tmp/wt","worktreePreserved":false,"finalText":"looks ok",
                "costUsd":0.05,"timestamp":"2026-07-06T19:12:02.123Z","stage":"review"}"#,
        );
        write(&dir.join("2026-07-06T19-12-02-123Z-implement.diff"), "diff --git a b\n+x");
        write(&dir.join("2026-07-06T19-12-02-123Z-implement.transcript.log"), "line1\nline2");
        write(
            &dir.join("2026-07-06T19-12-02-123Z.proof.json"),
            r#"{"command":"pnpm test","exitCode":1,"passed":false,"sha256":"deadbeef","outputTail":"1 test failed"}"#,
        );
    }

    #[test]
    fn sanitize_matches_vanguard() {
        assert_eq!(sanitize_timestamp("2026-07-06T19:12:02.123Z"), "2026-07-06T19-12-02-123Z");
    }

    #[test]
    fn groups_stages_into_one_run() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let out = list_run_summaries(tmp.path()).unwrap();
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.task_id, "task-7");
        assert_eq!(s.stages, vec!["implement".to_string(), "review".to_string()]);
        assert!((s.total_cost_usd - 0.17).abs() < 1e-9);
        assert!(!s.any_failed);
        assert_eq!(s.pr_url.as_deref(), Some("http://pr/1"));
    }

    #[test]
    fn reads_detail_with_diff_transcript_proof() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let d = read_run_detail(tmp.path(), "task-7", "2026-07-06T19:12:02.123Z").unwrap();
        assert_eq!(d.stages.len(), 2);
        let implement = d
            .stages
            .iter()
            .find(|s| s.record.stage.as_deref() == Some("implement"))
            .unwrap();
        assert_eq!(implement.diff.as_deref(), Some("diff --git a b\n+x"));
        assert_eq!(implement.transcript.as_deref(), Some("line1\nline2"));
        let proof = d.proof.as_ref().unwrap();
        assert!(!proof.passed);
        assert_eq!(proof.exit_code, 1);
    }

    #[test]
    fn rejects_path_traversal_task_id() {
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        assert!(read_run_detail(tmp.path(), "../task-7", "x").is_err());
        assert!(read_run_detail(tmp.path(), "a/b", "x").is_err());
        assert!(read_run_detail(tmp.path(), "", "x").is_err());
    }

    #[test]
    fn missing_runs_dir_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_run_summaries(tmp.path()).unwrap().is_empty());
    }
}
