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
    /// Per-project identity color (`#rrggbb`). When unset the app derives one from the repo path.
    pub color: Option<String>,
    pub provider: Option<String>,
    pub review_provider: Option<String>,
    pub verify_cmd: Option<String>,
    pub concurrency: Option<u32>,
    pub budget_usd: Option<f64>,
    pub run_command: Option<String>,
    /// Doc-editor chat model (Subsystem 3), e.g. `claude-sonnet-5`. Non-secret; the API key is never
    /// stored here (env only). Optional Anthropic-compatible base URL for a self-hosted proxy.
    pub chat_model: Option<String>,
    pub chat_base_url: Option<String>,
    /// Custom providers (Subsystem 6). Deliberately a raw `Value`, NOT a typed Vec: Rust is a dumb
    /// pipe here — a typed struct would silently strip unknown entry keys on every Settings save
    /// and collapse the whole config to `Default` on one type-mismatched entry. The core loader
    /// (src/agents/custom.ts) is the one validity predicate; keys never live in this file.
    pub custom_providers: Option<serde_json::Value>,
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

/// Settings read path (S6 guard b): a file that EXISTS but doesn't parse is an error, not
/// `Default` — collapsing it would let the next Save silently replace the whole hand-edited file.
/// Absent file still means defaults. Passive consumers (board, projects, chat) keep `read`.
pub fn read_strict(repo: &Path) -> Result<AppConfig, String> {
    match fs::read_to_string(config_path(repo)) {
        Err(_) => Ok(AppConfig::default()),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!(".vanguard/app.json is unreadable: {e}")),
    }
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

    #[test]
    fn read_strict_distinguishes_unreadable_from_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_strict(tmp.path()).is_ok()); // absent -> defaults
        fs::create_dir_all(tmp.path().join(".vanguard")).unwrap();
        fs::write(config_path(tmp.path()), "{not json").unwrap();
        assert!(read_strict(tmp.path()).is_err()); // unreadable -> error, NOT Default
        assert!(read(tmp.path()).source.is_none()); // passive read keeps collapse-to-default
    }

    #[test]
    fn custom_providers_round_trip_arbitrary_content() {
        // The S6 invariant: a read→write cycle (any Settings save) must preserve hand-written
        // customProviders byte-content — including entry keys this binary has never heard of.
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".vanguard")).unwrap();
        fs::write(
            config_path(tmp.path()),
            r#"{"label":"x","customProviders":[{"name":"my-proxy","baseUrl":"https://llm.example.com/api","keyEnv":"MY_KEY","model":"glm-5.2","futureKey":{"nested":true}}]}"#,
        )
        .unwrap();
        let cfg = read(tmp.path());
        write(tmp.path(), &cfg).unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config_path(tmp.path())).unwrap()).unwrap();
        let entry = &back["customProviders"][0];
        assert_eq!(entry["name"], "my-proxy");
        assert_eq!(entry["keyEnv"], "MY_KEY");
        assert_eq!(entry["futureKey"]["nested"], true);
    }
}
