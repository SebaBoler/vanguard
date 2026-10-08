import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, it, expect } from 'vitest';
import { assertSafeBaseBranch, redactGitError, resolveRemoteBaseRef } from './base-branch.js';

describe('assertSafeBaseBranch', () => {
  it.each(['', '   ', '-dev', '--upload-pack=false', '+main', 'feature:main', '+refs/heads/x:refs/heads/main'])('rejects %s', (base) => {
    expect(() => assertSafeBaseBranch(base)).toThrow('Invalid base branch');
  });

  it.each([
    ['newline', 'main\nfake'],
    ['ANSI escape', 'main\u001b[31m'],
    ['NUL', 'ma\u0000in'],
    ['DEL', 'main\u007f'],
  ])('rejects a control character (%s)', (_label, base) => {
    expect(() => assertSafeBaseBranch(base)).toThrow('Invalid base branch');
  });

  it('escapes control characters in the message, so a value cannot forge log or terminal lines', () => {
    expect(() => assertSafeBaseBranch('-x\n\u001b[31mfake')).toThrow('Invalid base branch "-x\\n\\u001b[31mfake"');
  });

  it('accepts a normal branch name', () => {
    expect(() => assertSafeBaseBranch('release/1.2')).not.toThrow();
  });
});

describe('resolveRemoteBaseRef', () => {
  const dirs: string[] = [];
  const mk = async (prefix: string): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  const commit = async (cwd: string, msg: string): Promise<void> => {
    await writeFile(join(cwd, 'f.txt'), msg);
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg], { cwd });
  };
  const originAndClone = async (): Promise<{ origin: string; clone: string }> => {
    const origin = await mk('vg-origin-');
    await execa('git', ['init', '-b', 'main'], { cwd: origin });
    await commit(origin, 'v1');
    const clone = await mk('vg-clone-');
    await execa('git', ['clone', '-q', origin, clone]);
    return { origin, clone };
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('prefers origin/<base> when the remote moved past the local base (#423)', async () => {
    const { origin, clone } = await originAndClone();
    await commit(origin, 'v2');
    const originTip = (await execa('git', ['rev-parse', 'main'], { cwd: origin })).stdout;
    // The SHA itself: a concurrent run's fetch cannot move it, and no same-named tag can shadow it.
    expect(await resolveRemoteBaseRef(clone, 'main')).toBe(originTip);
    expect((await execa('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: clone })).stdout).toBe(originTip);
  });

  it('keeps the local base when it is ahead of origin (unpushed commits)', async () => {
    const { clone } = await originAndClone();
    await commit(clone, 'local-only');
    expect(await resolveRemoteBaseRef(clone, 'main', { keepLocalIfAhead: true })).toBe('refs/heads/main');
  });

  it('compares the local BRANCH, not a same-named tag, when deciding ahead/diverged', async () => {
    const { origin, clone } = await originAndClone();
    await commit(origin, 'v2');
    await commit(clone, 'local-only');
    // A tag named `main` pointing at origin's NEW tip: read as the local base it would look behind,
    // and the resolver would wrongly prefer origin over the branch's unpushed commit.
    await execa('git', ['fetch', 'origin', 'main'], { cwd: clone });
    await execa('git', ['tag', 'main', 'FETCH_HEAD'], { cwd: clone });
    const ref = await resolveRemoteBaseRef(clone, 'main', { keepLocalIfAhead: true });
    expect(ref).toBe('refs/heads/main');
    // Unambiguous for worktree add / log: resolves to the branch tip, not the tag.
    expect((await execa('git', ['rev-parse', ref], { cwd: clone })).stdout).toBe((await execa('git', ['rev-parse', 'refs/heads/main'], { cwd: clone })).stdout);
  });

  it('on CI (keepLocalIfAhead false) a diverged local base is ignored and origin wins', async () => {
    const { clone } = await originAndClone();
    await commit(clone, 'local-only');
    expect(await resolveRemoteBaseRef(clone, 'main', { keepLocalIfAhead: false })).toBe((await execa('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: clone })).stdout);
  });

  it('uses origin/<base> when local and remote are equal (harmless either way)', async () => {
    const { clone } = await originAndClone();
    expect(await resolveRemoteBaseRef(clone, 'main')).toBe((await execa('git', ['rev-parse', 'refs/heads/main'], { cwd: clone })).stdout);
  });

  it('falls back to the local base with no remote', async () => {
    const repo = await mk('vg-local-');
    await execa('git', ['init', '-b', 'main'], { cwd: repo });
    await commit(repo, 'v1');
    expect(await resolveRemoteBaseRef(repo, 'main')).toBe('refs/heads/main');
  });

  it('tracks a base a single-branch clone did not fetch before (explicit refspec)', async () => {
    const { origin, clone } = await originAndClone();
    await execa('git', ['branch', 'dev'], { cwd: origin });
    await execa('git', ['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], { cwd: clone });
    const devTip = (await execa('git', ['rev-parse', 'dev'], { cwd: origin })).stdout;
    expect(await resolveRemoteBaseRef(clone, 'dev')).toBe(devTip);
    expect((await execa('git', ['rev-parse', 'refs/remotes/origin/dev'], { cwd: clone })).stdout).toBe(devTip);
  });

  it('reports a base origin does not carry and keeps the local one', async () => {
    const { clone } = await originAndClone();
    await execa('git', ['branch', 'only-local'], { cwd: clone });
    expect(await resolveRemoteBaseRef(clone, 'only-local')).toBe('refs/heads/only-local');
  });

  it('redacts URL userinfo and tokens from a git fetch error', () => {
    const err = new Error("warning: x\nfatal: unable to access 'https://x-access-token:ghs_abc@github.com/o/r/': 403\nmore");
    expect(redactGitError(err)).toBe("fatal: unable to access 'https://***@github.com/o/r/': 403");
  });

  it('retries a fetch that lost the ref lock to a concurrent fetch (#434)', async () => {
    const { origin, clone } = await originAndClone();
    await commit(origin, 'v2');
    // Hold the lock the way a concurrent `git fetch` would, release it after the first attempt failed.
    const lock = join(clone, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    await writeFile(lock, '');
    // git itself retries the lock for core.filesRefLockTimeout (100 ms); hold it longer than that so the
    // first attempt really fails and only our retry (250 ms, then 500 ms backoff) can succeed.
    const release = setTimeout(() => { void rm(lock, { force: true }); }, 700);
    const lines: string[] = [];
    try {
      const got = await resolveRemoteBaseRef(clone, 'main', { logger: { warn: (_o: unknown, m: string) => { lines.push(m); }, info: () => {} } as never });
      expect(got).toBe((await execa('git', ['rev-parse', 'main'], { cwd: origin })).stdout);
    } finally {
      clearTimeout(release);
      await rm(lock, { force: true });
    }
    expect(lines.some((l) => /locked by a concurrent fetch — retrying/.test(l))).toBe(true);
  });

  it('logs a fetch failure that is not a missing ref and keeps the local base', async () => {
    const { clone } = await originAndClone();
    await execa('git', ['remote', 'set-url', 'origin', join(clone, 'no-such-remote')], { cwd: clone });
    const lines: string[] = [];
    const got = await resolveRemoteBaseRef(clone, 'main', { logger: { warn: (_o: unknown, m: string) => { lines.push(m); }, info: () => {} } as never });
    expect(got).toBe('refs/heads/main');
    expect(lines[0]).toMatch(/git fetch origin main failed — using local main/);
  });

  it('rejects an unsafe base before touching git', async () => {
    await expect(resolveRemoteBaseRef('/nowhere', '-x')).rejects.toThrow(/Invalid base branch/);
    // `*` would make the explicit refspec a wildcard fetch of every branch.
    await expect(resolveRemoteBaseRef('/nowhere', '*')).rejects.toThrow(/Invalid base branch/);
    await expect(resolveRemoteBaseRef('/nowhere', 'rel[1]')).rejects.toThrow(/Invalid base branch/);
  });
});
