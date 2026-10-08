import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, it, expect } from 'vitest';
import { assertSafeBaseBranch, resolveRemoteBaseRef } from './base-branch.js';

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
    expect(await resolveRemoteBaseRef(clone, 'main')).toBe('origin/main');
    const cut = (await execa('git', ['rev-parse', 'origin/main'], { cwd: clone })).stdout;
    expect(cut).toBe((await execa('git', ['rev-parse', 'main'], { cwd: origin })).stdout);
  });

  it('keeps the local base when it is ahead of origin (unpushed commits)', async () => {
    const { clone } = await originAndClone();
    await commit(clone, 'local-only');
    expect(await resolveRemoteBaseRef(clone, 'main')).toBe('main');
  });

  it('uses origin/<base> when local and remote are equal (harmless either way)', async () => {
    const { clone } = await originAndClone();
    expect(await resolveRemoteBaseRef(clone, 'main')).toBe('origin/main');
  });

  it('falls back to the local base with no remote', async () => {
    const repo = await mk('vg-local-');
    await execa('git', ['init', '-b', 'main'], { cwd: repo });
    await commit(repo, 'v1');
    expect(await resolveRemoteBaseRef(repo, 'main')).toBe('main');
  });

  it('rejects an unsafe base before touching git', async () => {
    await expect(resolveRemoteBaseRef('/nowhere', '-x')).rejects.toThrow(/Invalid base branch/);
  });
});
