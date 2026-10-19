// `clone_project`: hub-only (src/wire.ts HUB_ONLY) companion to `add_project` for a fresh install or
// a VPS hub with nothing to browse yet — clone a repo URL under the browse root, then hand the result
// to the same allowlist + project-store path `add_project` uses. See docs/hub.md § Add project.
import { execa } from 'execa';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestError } from '../sidecar/sidecar.js';
import { isWithinRoot } from './browse.js';

/** Hosts `clone_project` accepts without an explicit opt-in. `cloneHosts` (`createHubServer`)
 * can extend this for a self-hosted GitHub/GitLab instance. */
export const DEFAULT_CLONE_HOSTS = ['github.com', 'gitlab.com'] as const;

/** Injectable shell-out, defaulting to the real `execa` — tests pass a fake (`src/hub/clone.test.ts`,
 * no network). `onLine` is best-effort progress streaming: the default implementation wires it to
 * the child's combined stdout+stderr, a fake can just call it directly. */
export interface CloneExec {
  (
    file: string,
    args: string[],
    options?: { timeout?: number; onLine?: ((line: string) => void) | undefined },
  ): Promise<{ stdout: string; stderr: string }>;
}

const defaultCloneExec: CloneExec = async (file, args, options) => {
  const subprocess = execa(file, args, {
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    all: true,
  });
  if (options?.onLine) {
    const onLine = options.onLine;
    subprocess.all?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed !== '') onLine(trimmed);
      }
    });
  }
  const result = await subprocess;
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/** `git@host:org/repo.git` scp-style shorthand (no `scheme://`) — the other form `clone_project` accepts. */
const SCP_LIKE_RE = /^git@([^:/]+):/;

/** The URL's host, having rejected anything that isn't `https://` or `ssh://`/`git@` — no `file://`,
 * no bare local path, no other scheme. Throws `BadRequestError` (surfaced to the dialog verbatim). */
export function cloneUrlHost(url: string): string {
  // Git and WHATWG URL parsing disagree on backslashes and stripped control characters.
  if (/[\\\x00-\x20\x7f]/.test(url)) throw new BadRequestError('invalid repository URL');
  const scp = SCP_LIKE_RE.exec(url);
  if (scp) return scp[1]!;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError(`not a valid repository URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw new BadRequestError(`unsupported URL scheme "${parsed.protocol}" — only https:// and ssh:// (or git@host:) URLs are allowed`);
  }
  if (!url.startsWith(`${parsed.protocol}//`) || parsed.hostname === '') {
    throw new BadRequestError(`not a valid repository URL: ${url}`);
  }
  return parsed.hostname;
}

/** The default folder name: the URL's last path segment, minus a `.git` suffix. */
export function repoNameFromUrl(url: string): string {
  const path = SCP_LIKE_RE.test(url) ? url.slice(url.indexOf(':') + 1) : new URL(url).pathname;
  const last = path.replace(/\/$/, '').split('/').at(-1)?.replace(/\.git$/, '');
  if (!last) {
    throw new BadRequestError(`cannot derive a folder name from ${url}`);
  }
  return last;
}

function assertSafeFolderName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new BadRequestError(`invalid folder name: ${name}`);
  }
}

/** Resolve `name` under `parentDir`, confined to `browseRoot` — mirrors `browseDirs`'s traversal
 * guard (realpath both sides). Refuses a target outside the root, and an existing non-empty dir
 * (an existing EMPTY dir, e.g. one the user just mkdir'd, is fine to clone into). */
async function resolveCloneTarget(browseRoot: string, parentDir: string, name: string): Promise<string> {
  assertSafeFolderName(name);
  const realRoot = await realpath(browseRoot);
  let realParent: string;
  try {
    realParent = await realpath(parentDir);
  } catch {
    throw new BadRequestError(`parent directory does not exist: ${parentDir}`);
  }
  if (!isWithinRoot(realRoot, realParent)) {
    throw new BadRequestError('parent directory escapes the browse root');
  }
  const target = join(realParent, name);
  let st;
  try {
    st = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw error;
  }
  if (st.isSymbolicLink()) throw new BadRequestError(`${target} is a symbolic link`);
  if (!st.isDirectory()) {
    throw new BadRequestError(`${target} exists and is not a directory`);
  }
  const entries = await readdir(target);
  if (entries.length > 0) {
    throw new BadRequestError(`${target} already exists and is not empty`);
  }
  return target;
}

async function ghAuthenticated(exec: CloneExec): Promise<boolean> {
  try {
    await exec('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface CloneProjectParams {
  url: string;
  parentDir: string;
  name?: string | undefined;
}

export interface CloneProjectDeps {
  exec?: CloneExec;
  allowedHosts?: readonly string[] | undefined;
  onProgress?: (line: string) => void;
}

/** Clone `params.url` under `browseRoot` and return the absolute path of the new work tree. Uses
 * `gh repo clone` for a github.com host when `gh` is authenticated (so private repos work with the
 * host's own credentials), plain `git clone` otherwise. Does not touch the project store — the
 * caller (`src/hub/rpc.ts`'s `clone_project`) does that via `./projects.js`, exactly like `add_project`. */
export async function cloneProject(browseRoot: string, params: CloneProjectParams, deps: CloneProjectDeps = {}): Promise<string> {
  const exec = deps.exec ?? defaultCloneExec;
  const allowedHosts = [...DEFAULT_CLONE_HOSTS, ...(deps.allowedHosts ?? [])];
  const url = params.url.trim();
  if (url === '') throw new BadRequestError('url is required');

  const host = cloneUrlHost(url);
  if (!allowedHosts.includes(host)) {
    throw new BadRequestError(`"${host}" is not an allowed clone host — allowed: ${allowedHosts.join(', ')}`);
  }

  const name = params.name?.trim() || repoNameFromUrl(url);
  const target = await resolveCloneTarget(browseRoot, params.parentDir, name);

  const useGh = host === 'github.com' && (await ghAuthenticated(exec));
  const command = useGh ? 'gh' : 'git';
  const args = useGh ? ['repo', 'clone', url, target] : ['clone', url, target];

  try {
    await exec(command, args, { onLine: deps.onProgress, timeout: 10 * 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: unknown } | null)?.stderr;
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : message;
    throw new BadRequestError(`git clone failed: ${text.trim()}`);
  }

  return target;
}
