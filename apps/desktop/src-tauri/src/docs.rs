use std::fs;
use std::path::{Path, PathBuf};

/// Idea/plan markdown docs live under `<repo>/.vanguard/docs/` (Subsystem 3). Repo-local so a plan
/// travels with the repo it plans to change; Subsystem 4 reads these to create tasks.
fn docs_dir(repo: &Path) -> PathBuf {
    repo.join(".vanguard").join("docs")
}

/// Reject path-traversal / nesting; docs are flat files directly under `.vanguard/docs/`.
fn safe_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("invalid doc name: {name}"));
    }
    Ok(())
}

/// List `*.md` basenames, sorted. Missing dir → empty (not an error).
pub fn list(repo: &Path) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(docs_dir(repo)) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".md"))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

pub fn read(repo: &Path, name: &str) -> Result<String, String> {
    safe_name(name)?;
    fs::read_to_string(docs_dir(repo).join(name)).map_err(|e| e.to_string())
}

pub fn write(repo: &Path, name: &str, content: &str) -> Result<(), String> {
    safe_name(name)?;
    if !name.ends_with(".md") {
        return Err("doc name must end with .md".into());
    }
    let dir = docs_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(name), content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_md_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "b.md", "b").unwrap();
        write(tmp.path(), "a.md", "a").unwrap();
        fs::write(docs_dir(tmp.path()).join("note.txt"), "x").unwrap();
        assert_eq!(list(tmp.path()), vec!["a.md".to_string(), "b.md".to_string()]);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "plan.md", "# Plan\n").unwrap();
        assert_eq!(read(tmp.path(), "plan.md").unwrap(), "# Plan\n");
    }

    #[test]
    fn missing_dir_lists_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list(tmp.path()).is_empty());
    }

    #[test]
    fn rejects_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write(tmp.path(), "../evil.md", "x").is_err());
        assert!(read(tmp.path(), "../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_non_md() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write(tmp.path(), "plan.txt", "x").is_err());
    }
}
