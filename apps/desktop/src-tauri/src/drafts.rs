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

/// Leaf-file guard (review #349 r3): the dir checks don't cover a committed symlink FILE — read
/// would follow `<id>.json` out of the tree, and `fs::write` follows a dangling `.gitignore` or
/// `.tmp` symlink, planting an attacker-chosen file outside the checkout.
fn assert_leaf_not_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("{} is a symlink — refusing to operate on it", path.display()))
        }
        _ => Ok(()),
    }
}

pub fn read(repo: &Path, id: &str) -> Result<String, String> {
    safe_name(id)?;
    assert_not_symlink(repo)?;
    let file = drafts_dir(repo).join(format!("{id}.json"));
    assert_leaf_not_symlink(&file)?;
    fs::read_to_string(file).map_err(|e| e.to_string())
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
    // symlink_metadata, not exists(): a DANGLING symlink reports !exists() and fs::write would
    // follow it, planting a file outside the checkout (review #349 r3, vector B).
    assert_leaf_not_symlink(&ignore)?;
    if !ignore.exists() {
        fs::write(&ignore, "*\n").map_err(|e| e.to_string())?;
    }
    let tmp = dir.join(format!("{id}.json.tmp"));
    assert_leaf_not_symlink(&tmp)?;
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    // rename replaces the target without following it, so a symlinked `<id>.json` is overwritten
    // by a real file rather than written through.
    fs::rename(&tmp, dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

/// Composer image attachments (Editor UX 7/7) live beside the draft they belong to, under
/// `<repo>/.vanguard/drafts/<id>-assets/`. Same tree, same `.gitignore` (`.vanguard/drafts/*` is
/// already ignored via the drafts `.gitignore`'s `*`), so a pasted image never rides a commit.
fn assets_dir(repo: &Path, id: &str) -> PathBuf {
    drafts_dir(repo).join(format!("{id}-assets"))
}

/// A safe attachment filename: no separators, no traversal, no dotfile. The webview mints these
/// (`<uuid>.<ext>`), but this seam re-validates — a smuggled `../` or absolute name must never
/// reach `join`.
fn safe_asset_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err(format!("invalid asset name: {name}"));
    }
    Ok(())
}

/// Persist an image attachment under the draft's assets dir and return its ABSOLUTE path — the value
/// the renderer hands to `__complete` as the image content block's source. Symlink-safe like `write`:
/// the assets dir and the leaf are both checked, so a committed symlink can't redirect the write out
/// of the checkout. Returns the path so the send path can forward it without re-deriving the layout.
pub fn write_asset(repo: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    writable_id(id)?;
    safe_asset_name(name)?;
    assert_not_symlink(repo)?;
    let dir = assets_dir(repo, id);
    if let Ok(meta) = fs::symlink_metadata(&dir) {
        if meta.file_type().is_symlink() {
            return Err(format!("{} is a symlink — refusing to operate on it", dir.display()));
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(name);
    assert_leaf_not_symlink(&file)?;
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Idempotent: deleting a missing draft succeeds (a lost race with a second window is not an error).
pub fn delete(repo: &Path, id: &str) -> Result<(), String> {
    safe_name(id)?;
    assert_not_symlink(repo)?;
    // The draft's pasted-image assets go with it — leaving `<id>-assets/` behind on the one
    // operation meant to clean up would be an unbounded on-disk leak (review r2). Same symlink
    // guard as write_asset: a swapped-in link must not have its TARGET's contents removed.
    let assets = assets_dir(repo, id);
    assert_leaf_not_symlink(&assets)?;
    match fs::remove_dir_all(&assets) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
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
    fn delete_removes_the_assets_dir_with_the_draft() {
        // Orphaned `<id>-assets/` dirs would grow forever in every repo (review r2).
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "draft-x", "{}").unwrap();
        let asset = write_asset(tmp.path(), "draft-x", "pic.png", b"bytes").unwrap();
        assert!(Path::new(&asset).exists());
        delete(tmp.path(), "draft-x").unwrap();
        assert!(!Path::new(&asset).exists());
        assert!(!assets_dir(tmp.path(), "draft-x").exists());
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
    fn refuses_symlinked_leaf_files() {
        // review #349 r3: the dir checks alone leave two leaf vectors open in a hostile clone —
        // read follows a committed `<id>.json` symlink out of the tree, and a DANGLING
        // `.gitignore` symlink (exists() == false) gets written through, creating an
        // attacker-chosen file outside the checkout.
        let repo = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dir = drafts_dir(repo.path());
        fs::create_dir_all(&dir).unwrap();

        // Vector A: read must not follow a symlinked draft file.
        fs::write(outside.path().join("loot.json"), "{\"body\":\"secret\",\"chat\":[]}").unwrap();
        std::os::unix::fs::symlink(outside.path().join("loot.json"), dir.join("draft-evil.json")).unwrap();
        assert!(read(repo.path(), "draft-evil").is_err());

        // Vector B: a dangling .gitignore symlink must not be written through.
        std::os::unix::fs::symlink(outside.path().join("planted"), dir.join(".gitignore")).unwrap();
        assert!(write(repo.path(), "draft-a", "{}").is_err());
        assert!(!outside.path().join("planted").exists());

        // Vector C: a committed `<id>.json.tmp` symlink must not receive the staged write.
        fs::remove_file(dir.join(".gitignore")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("smuggled"), dir.join("draft-b.json.tmp")).unwrap();
        assert!(write(repo.path(), "draft-b", "{}").is_err());
        assert!(!outside.path().join("smuggled").exists());
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
