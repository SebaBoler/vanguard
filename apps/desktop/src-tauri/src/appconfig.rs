use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The app's per-project config (`.vanguard/app.json`, spec §6). All optional; the CLI does not read
/// this — the app translates it into flags / a launch command.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub source: Option<String>, // github | gitlab | linear
    pub label: Option<String>,
    /// Linear team key (e.g. `DEV`) — selects which team's issues the board lists. Linear-only;
    /// GitHub/GitLab scope by repo + `label`.
    pub team: Option<String>,
    pub provider: Option<String>,
    pub review_provider: Option<String>,
    pub verify_cmd: Option<String>,
    pub concurrency: Option<u32>,
    pub budget_usd: Option<f64>,
    pub run_command: Option<String>,
}

fn config_path(repo: &Path) -> PathBuf {
    repo.join(".vanguard").join("app.json")
}

pub fn read(repo: &Path) -> AppConfig {
    fs::read_to_string(config_path(repo))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write(repo: &Path, cfg: &AppConfig) -> io::Result<()> {
    fs::create_dir_all(repo.join(".vanguard"))?;
    let json = serde_json::to_string_pretty(cfg).map_err(io::Error::other)?;
    fs::write(config_path(repo), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            source: Some("linear".into()),
            label: Some("vanguard-ready".into()),
            concurrency: Some(3),
            budget_usd: Some(2.5),
            ..Default::default()
        };
        write(tmp.path(), &cfg).unwrap();
        let back = read(tmp.path());
        assert_eq!(back.source.as_deref(), Some("linear"));
        assert_eq!(back.concurrency, Some(3));
        assert_eq!(back.budget_usd, Some(2.5));
    }

    #[test]
    fn missing_config_is_default() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read(tmp.path()).source.is_none());
    }
}
