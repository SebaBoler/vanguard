// Port of apps/desktop/src-tauri/src/drafts.rs — see that file for the original Rust implementation.
import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';

/** Task drafts live under `<repo>/.vanguard/drafts/` (Subsystem 10) — one JSON file per draft,
 * body + chat transcript + meta together. We stay dumb: raw strings in and out, the webview owns
 * the JSON shape. Repo-local so a draft travels with the repo it plans to change. */
function draftsDir(repoPath: string): string {
  return join(repoPath, '.vanguard', 'drafts');
}

/** The drafts dir must be a real directory: a cloned repo can commit `.vanguard/drafts` — or
 * `.vanguard` itself (review #349 r1: following only the leaf misses a symlinked parent) — as a
 * symlink, and following either would redirect writes/deletes outside the checkout. */
async function assertNotSymlink(repoPath: string): Promise<void> {
  for (const dir of [join(repoPath, '.vanguard'), draftsDir(repoPath)]) {
    try {
      const meta = await lstat(dir);
      if (meta.isSymbolicLink()) {
        throw new BadRequestError(`${dir} is a symlink — refusing to operate on it`);
      }
    } catch (e) {
      if (e instanceof BadRequestError) throw e;
      // Missing path is fine (not a symlink); any other stat failure is ignored here too, same
      // as the Rust `if let Ok(meta) = ...` which only acts on success.
    }
  }
}

/** Lenient name rule for list/delete: anything `list` could have returned must be deletable, or a
 * hand-named `My Draft.json` becomes the un-removable file this subsystem exists to kill. */
function safeName(id: string): void {
  if (id === '' || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new BadRequestError(`invalid draft id: ${id}`);
  }
}

/** Strict rule for write: only ids we mint (`draft-<ts36>-<rand>`). A write with a smuggled
 * extension or arbitrary name never reaches disk through this seam. */
function writableId(id: string): void {
  if (id === '' || !/^[a-z0-9-]+$/.test(id)) {
    throw new BadRequestError(`invalid draft id: ${id}`);
  }
}

/** Leaf-file guard (review #349 r3): the dir checks don't cover a committed symlink FILE — read
 * would follow `<id>.json` out of the tree, and a plain write follows a dangling `.gitignore` or
 * `.tmp` symlink, planting an attacker-chosen file outside the checkout. */
async function assertLeafNotSymlink(path: string): Promise<void> {
  try {
    const meta = await lstat(path);
    if (meta.isSymbolicLink()) {
      throw new BadRequestError(`${path} is a symlink — refusing to operate on it`);
    }
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    // Missing path: nothing to guard against.
  }
}

/** List draft ids (`*.json` stems, `.tmp` excluded), most recently modified first. */
export async function list(repoPath: string): Promise<string[]> {
  try {
    await assertNotSymlink(repoPath);
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = await readdir(draftsDir(repoPath));
  } catch {
    return [];
  }
  const entries: Array<{ id: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    if (stem === '') continue;
    // An unreadable mtime must not hide the draft (AC6: every draft visible and deletable) — it
    // lists last instead of vanishing.
    let mtime = 0;
    try {
      const st = await stat(join(draftsDir(repoPath), name));
      mtime = st.mtimeMs;
    } catch {
      mtime = 0;
    }
    entries.push({ id: stem, mtime });
  }
  entries.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries.map((e) => e.id);
}

export async function read(repoPath: string, id: string): Promise<string> {
  safeName(id);
  await assertNotSymlink(repoPath);
  const file = join(draftsDir(repoPath), `${id}.json`);
  await assertLeafNotSymlink(file);
  return readFile(file, 'utf8');
}

/** Atomic write: tmp + rename, so a torn write can never degrade a draft (body, transcript, and
 * created-issue link all live in this one file) to unreadable. Also self-seeds a `.gitignore`
 * containing `*`: user repos TRACK `.vanguard/` (flows are committed artifacts since S5.1), and
 * chat transcripts must never ride a `git add -A` into a commit. */
export async function write(repoPath: string, id: string, content: string): Promise<void> {
  writableId(id);
  await assertNotSymlink(repoPath);
  const dir = draftsDir(repoPath);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  // lstat, not exists(): a DANGLING symlink reports as not-existing via stat but IS a symlink via
  // lstat, and a plain write would follow it, planting a file outside the checkout (review #349
  // r3, vector B).
  await assertLeafNotSymlink(ignore);
  let ignoreExists = true;
  try {
    await stat(ignore);
  } catch {
    ignoreExists = false;
  }
  if (!ignoreExists) {
    await writeFile(ignore, '*\n');
  }
  const tmp = join(dir, `${id}.json.tmp`);
  await assertLeafNotSymlink(tmp);
  await writeFile(tmp, content);
  // rename replaces the target without following it, so a symlinked `<id>.json` is overwritten by
  // a real file rather than written through.
  await rename(tmp, join(dir, `${id}.json`));
}

/** Composer image attachments (Editor UX 7/7) live beside the draft they belong to, under
 * `<repo>/.vanguard/drafts/<id>-assets/`. Same tree, same `.gitignore` (`.vanguard/drafts/*` is
 * already ignored via the drafts `.gitignore`'s `*`), so a pasted image never rides a commit. */
function assetsDir(repoPath: string, id: string): string {
  return join(draftsDir(repoPath), `${id}-assets`);
}

/** A safe attachment filename: no separators, no traversal, no dotfile. The webview mints these
 * (`<uuid>.<ext>`), but this seam re-validates — a smuggled `../` or absolute name must never
 * reach `join`. */
function safeAssetName(name: string): void {
  if (name === '' || name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new BadRequestError(`invalid asset name: ${name}`);
  }
}

/** Persist an image attachment under the draft's assets dir and return its ABSOLUTE path — the
 * value the renderer hands to `__complete` as the image content block's source. Symlink-safe like
 * `write`: the assets dir and the leaf are both checked, so a committed symlink can't redirect the
 * write out of the checkout. Returns the path so the send path can forward it without re-deriving
 * the layout. */
export async function writeAsset(repoPath: string, id: string, name: string, bytes: Uint8Array): Promise<string> {
  writableId(id);
  safeAssetName(name);
  await assertNotSymlink(repoPath);
  const dir = assetsDir(repoPath, id);
  try {
    const meta = await lstat(dir);
    if (meta.isSymbolicLink()) {
      throw new BadRequestError(`${dir} is a symlink — refusing to operate on it`);
    }
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
  }
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await assertLeafNotSymlink(file);
  await writeFile(file, bytes);
  return file;
}

/** Remove a draft's pasted-image assets dir, keeping the draft JSON. Called when a draft is FILED
 * (archived): the images already rode the chat that produced the task, so they are dead weight —
 * leaving them would leak per-send for the life of every filed draft (review r5). Idempotent; same
 * symlink guard as `del`. Split from `del` so the file itself survives archiving. */
export async function clearAssets(repoPath: string, id: string): Promise<void> {
  safeName(id);
  await assertNotSymlink(repoPath);
  const assets = assetsDir(repoPath, id);
  await assertLeafNotSymlink(assets);
  await rm(assets, { recursive: true, force: true });
}

/** Idempotent: deleting a missing draft succeeds (a lost race with a second window is not an
 * error). */
export async function del(repoPath: string, id: string): Promise<void> {
  safeName(id);
  await assertNotSymlink(repoPath);
  // Remove the JSON FIRST: "anything list could return must be deletable" (AC6) is the invariant
  // the whole safeName leniency protects, so a delete must never be blocked. Asset cleanup is
  // best-effort AFTER (review r5->r7 regression): a symlinked/locked/permission-denied assets dir
  // must not resurrect the draft the user asked to remove. A leaked assets dir is a bounded leak;
  // an undeletable draft is the exact bug S10 exists to prevent.
  let removeError: unknown;
  try {
    await unlink(join(draftsDir(repoPath), `${id}.json`));
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) {
      removeError = e;
    }
  }
  try {
    await clearAssets(repoPath, id);
  } catch {
    // Best-effort — swallow any error.
  }
  if (removeError !== undefined) throw removeError;
}
