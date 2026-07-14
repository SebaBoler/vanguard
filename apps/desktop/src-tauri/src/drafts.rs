use std::fs;
use std::path::{Path, PathBuf};

/// Task drafts live under `<repo>/.vanguard/drafts/` (Subsystem 10) — one JSON file per draft,
/// body + chat transcript + meta together. Rust stays dumb: raw strings in and out, the webview
/// owns the JSON shape. Repo-local so a draft travels with the repo it plans to change.
fn drafts_dir(repo: &Path) -> PathBuf {
    repo.join(".vanguard").join("drafts")
}

/// The drafts dir must be a real directory: a cloned repo can commit `.vanguard/drafts` — or
/// `.vanguard` itself (review #349 r1: symlink_metadata follows intermediate components, so
/// checking only the leaf misses a symlinked parent) — as a symlink, and following either would
/// redirect writes/deletes outside the checkout.
fn assert_not_symlink(repo: &Path) -> Result<(), String> {
    for dir in [repo.join(".vanguard"), drafts_dir(repo)] {
        if let Ok(meta) = fs::symlink_metadata(&dir) {
            if meta.file_type().is_symlink() {
                return Err(format!("{} is a symlink — refusing to operate on it", dir.display()));
            }
        }
    }
    Ok(())
}

/// Lenient name rule for list/delete: anything `list` could have returned must be deletable,
/// or a hand-named `My Draft.json` becomes the un-removable file this subsystem exists to kill.
fn safe_name(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid draft id: {id}"));
    }
    Ok(())
}

/// Strict rule for write: only ids we mint (`draft-<ts36>-<rand>`). A write with a smuggled
/// extension or arbitrary name never reaches disk through this seam.
fn writable_id(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err(format!("invalid draft id: {id}"));
    }
    Ok(())
}

/// List draft ids (`*.json` stems, `.tmp` excluded), most recently modified first.
pub fn list(repo: &Path) -> Vec<String> {
    if assert_not_symlink(repo).is_err() {
        return Vec::new();
    }
    let mut entries: Vec<(String, std::time::SystemTime)> = match fs::read_dir(drafts_dir(repo)) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let stem = name.strip_suffix(".json")?.to_string();
                // Never surface our own gitignore or a tmp file mid-rename.
                if stem.is_empty() {
                    return None;
                }
                // An unreadable mtime must not hide the draft (AC6: every draft visible and
                // deletable) — it lists last instead of vanishing.
                let mtime = e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                Some((stem, mtime))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    entries.into_iter().map(|(id, _)| id).collect()
}

pub fn read(repo: &Path, id: &str) -> Result<String, String> {
    safe_name(id)?;
    assert_not_symlink(repo)?;
    fs::read_to_string(drafts_dir(repo).join(format!("{id}.json"))).map_err(|e| e.to_string())
}

/// Atomic write: tmp + rename, so a torn write can never degrade a draft (body, transcript, and
/// created-issue link all live in this one file) to unreadable. Also self-seeds a `.gitignore`
/// containing `*`: user repos TRACK `.vanguard/` (flows are committed artifacts since S5.1), and
/// chat transcripts must never ride a `git add -A` into a commit.
pub fn write(repo: &Path, id: &str, content: &str) -> Result<(), String> {
    writable_id(id)?;
    assert_not_symlink(repo)?;
    let dir = drafts_dir(repo);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        fs::write(&ignore, "*\n").map_err(|e| e.to_string())?;
    }
    let tmp = dir.join(format!("{id}.json.tmp"));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

/// Idempotent: deleting a missing draft succeeds (a lost race with a second window is not an error).
pub fn delete(repo: &Path, id: &str) -> Result<(), String> {
    safe_name(id)?;
    assert_not_symlink(repo)?;
    match fs::remove_file(drafts_dir(repo).join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "draft-abc-1234", "{\"body\":\"x\"}").unwrap();
        assert_eq!(read(tmp.path(), "draft-abc-1234").unwrap(), "{\"body\":\"x\"}");
    }

    #[test]
    fn missing_dir_lists_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list(tmp.path()).is_empty());
    }

    #[test]
    fn lists_mtime_desc_and_skips_tmp_and_gitignore() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "draft-old", "{}").unwrap();
        // Force distinct mtimes without sleeping.
        let dir = drafts_dir(tmp.path());
        let old = fs::metadata(dir.join("draft-old.json")).unwrap().modified().unwrap();
        write(tmp.path(), "draft-new", "{}").unwrap();
        let newer = old + std::time::Duration::from_secs(10);
        let f = fs::File::open(dir.join("draft-new.json")).unwrap();
        f.set_modified(newer).unwrap();
        fs::write(dir.join("draft-mid.json.tmp"), "{").unwrap();
        assert_eq!(list(tmp.path()), vec!["draft-new".to_string(), "draft-old".to_string()]);
    }

    #[test]
    fn lists_hand_named_files_and_deletes_them() {
        // Lenient list/delete: a hand-made file must be visible AND removable, or we have rebuilt
        // the un-removable-file bug for a different input class.
        let tmp = tempfile::tempdir().unwrap();
        let dir = drafts_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("My Draft.json"), "{not json").unwrap();
        assert_eq!(list(tmp.path()), vec!["My Draft".to_string()]);
        assert_eq!(read(tmp.path(), "My Draft").unwrap(), "{not json");
        delete(tmp.path(), "My Draft").unwrap();
        assert!(list(tmp.path()).is_empty());
    }

    #[test]
    fn write_is_strict_about_ids() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write(tmp.path(), "My Draft", "{}").is_err());
        assert!(write(tmp.path(), "draft.json", "{}").is_err()); // extension smuggling
        assert!(write(tmp.path(), "DRAFT-1", "{}").is_err());
        assert!(write(tmp.path(), "", "{}").is_err());
    }

    #[test]
    fn rejects_traversal_everywhere() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write(tmp.path(), "../evil", "{}").is_err());
        assert!(read(tmp.path(), "../../etc/passwd").is_err());
        assert!(delete(tmp.path(), "..").is_err());
        assert!(delete(tmp.path(), "a/b").is_err());
    }

    #[test]
    fn delete_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        delete(tmp.path(), "draft-never-existed").unwrap();
        write(tmp.path(), "draft-x", "{}").unwrap();
        delete(tmp.path(), "draft-x").unwrap();
        delete(tmp.path(), "draft-x").unwrap();
    }

    #[test]
    fn write_seeds_gitignore_and_leaves_no_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "draft-a", "{}").unwrap();
        let dir = drafts_dir(tmp.path());
        assert_eq!(fs::read_to_string(dir.join(".gitignore")).unwrap(), "*\n");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn refuses_symlinked_drafts_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join(".vanguard")).unwrap();
        std::os::unix::fs::symlink(target.path(), drafts_dir(tmp.path())).unwrap();
        assert!(write(tmp.path(), "draft-a", "{}").is_err());
        assert!(read(tmp.path(), "draft-a").is_err());
        assert!(delete(tmp.path(), "draft-a").is_err());
        assert!(list(tmp.path()).is_empty());
        // Nothing crossed the symlink.
        assert!(fs::read_dir(target.path()).unwrap().next().is_none());
    }

    #[test]
    fn refuses_symlinked_vanguard_parent() {
        // review #349 r1: a repo can commit `.vanguard` itself as the symlink; the leaf check
        // alone resolves through it and passes.
        let tmp = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        fs::create_dir_all(target.path().join("drafts")).unwrap();
        std::os::unix::fs::symlink(target.path(), tmp.path().join(".vanguard")).unwrap();
        assert!(write(tmp.path(), "draft-a", "{}").is_err());
        assert!(read(tmp.path(), "draft-a").is_err());
        assert!(delete(tmp.path(), "draft-a").is_err());
        assert!(list(tmp.path()).is_empty());
        assert!(fs::read_dir(target.path().join("drafts")).unwrap().next().is_none());
    }
}
