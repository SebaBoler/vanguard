/// A Run's `taskId` resolved to its Task Source and the ref the provider CLI wants.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTask {
    pub source: String,
    pub reference: String,
}

fn trailing_number(s: &str) -> Option<String> {
    let rev: String = s.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if rev.is_empty() {
        None
    } else {
        Some(rev.chars().rev().collect())
    }
}

/// Map a Vanguard taskId back to `(source, ref)` using the prefix conventions its runners mint:
/// `gh-…<n>` (GitHub issue), `gl-…<n>` (GitLab iid), `linear-<id>` (Linear identifier). `None` if
/// unrecognized. (Per-project custom patterns are a documented, deferred extension — spec §4.3.)
pub fn resolve(task_id: &str) -> Option<ResolvedTask> {
    let lower = task_id.to_lowercase();
    if let Some(rest) = lower.strip_prefix("linear-") {
        if rest.is_empty() {
            return None;
        }
        // linear-dev-639 -> DEV-639 (runners lowercase the identifier on the way in)
        return Some(ResolvedTask { source: "linear".into(), reference: rest.to_uppercase() });
    }
    if lower.starts_with("gh-") {
        return trailing_number(task_id).map(|n| ResolvedTask { source: "github".into(), reference: n });
    }
    if lower.starts_with("gl-") {
        return trailing_number(task_id).map(|n| ResolvedTask { source: "gitlab".into(), reference: n });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(source: &str, reference: &str) -> Option<ResolvedTask> {
        Some(ResolvedTask { source: source.into(), reference: reference.into() })
    }

    #[test]
    fn resolves_the_provider_conventions() {
        assert_eq!(resolve("gh-211"), r("github", "211"));
        assert_eq!(resolve("gh-owner-repo-211"), r("github", "211")); // sanitized slug -> trailing #
        assert_eq!(resolve("gl-5"), r("gitlab", "5"));
        assert_eq!(resolve("gl-group-proj-5"), r("gitlab", "5"));
        assert_eq!(resolve("linear-dev-639"), r("linear", "DEV-639"));
    }

    #[test]
    fn unrecognized_is_none() {
        assert_eq!(resolve("owner/repo#weird"), None);
        assert_eq!(resolve("spec-gh-211"), None); // spec-pass variant: source lost (spec §7)
        assert_eq!(resolve("linear-"), None);
        assert_eq!(resolve("gh-"), None); // no number
    }
}
