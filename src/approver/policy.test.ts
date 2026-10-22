import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { approverPolicySchema, loadPolicy, matchGlob } from './policy.js';

const raw = await readFile(new URL('../../.vanguard/approver.json', import.meta.url), 'utf8');
const policy = JSON.parse(raw) as Record<string, unknown>;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vg-policy-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await execa('git', ['init', '--quiet', '--bare', join(root, 'origin.git')]);
  await execa('git', ['init', '--quiet', '-b', 'main', repo]);
  await execa('git', ['config', 'user.email', 'test@local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'test'], { cwd: repo });
  await mkdir(join(repo, '.vanguard'));
  await writeFile(join(repo, '.vanguard/approver.json'), content);
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '--quiet', '-m', 'base'], { cwd: repo });
  await execa('git', ['remote', 'add', 'origin', join(root, 'origin.git')], { cwd: repo });
  await execa('git', ['push', '--quiet', 'origin', 'main'], { cwd: repo });
  return repo;
}

describe('approver policy', () => {
  it('validates the shipped policy, tolerates extra keys and rejects other versions', () => {
    expect(approverPolicySchema.parse({ ...policy, extra: true })).toEqual(policy);
    expect(approverPolicySchema.safeParse({ ...policy, schemaVersion: 2 }).success).toBe(false);
    expect(policy).toMatchObject({ shape: { maxLines: 150, maxFiles: 5 }, ledger: { windowDays: 7, maxLines: 300 }, auditSample: { p: 0.1 } });
  });

  it('reads the remote base despite a planted working-tree or unpushed local policy', async () => {
    const repo = await fixture(raw);
    await writeFile(join(repo, '.vanguard/approver.json'), JSON.stringify({ ...policy, enabled: false }));
    await execa('git', ['commit', '--quiet', '-am', 'local'], { cwd: repo });
    await writeFile(join(repo, '.vanguard/approver.json'), '{}');
    const loaded = await loadPolicy(repo, 'main');
    expect(loaded?.policy).toEqual(policy);
    expect(loaded?.raw).toBe(raw);
    expect(loaded?.policyHash).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`);
    expect(await loadPolicy(repo, 'main')).toEqual(loaded);
  });

  it('hashes exact file bytes including the final newline', async () => {
    const a = await loadPolicy(await fixture(raw), 'main');
    const b = await loadPolicy(await fixture(`${raw} `), 'main');
    expect(a?.policyHash).not.toBe(b?.policyHash);
  });

  it.each(['not json', '{}'])('fails closed on invalid policy %s', async (content) => {
    expect(await loadPolicy(await fixture(content), 'main')).toBeUndefined();
  });

  it('fails closed on missing policy and never falls back to a local-only branch', async () => {
    const repo = await fixture(raw);
    await execa('git', ['rm', '.vanguard/approver.json'], { cwd: repo });
    await execa('git', ['commit', '--quiet', '-m', 'remove'], { cwd: repo });
    await execa('git', ['push', '--quiet', 'origin', 'main'], { cwd: repo });
    expect(await loadPolicy(repo, 'main')).toBeUndefined();
    await execa('git', ['branch', 'local'], { cwd: repo });
    expect(await loadPolicy(repo, 'local')).toBeUndefined();
  });

  it.each([
    ['**/package.json', 'package.json', true], ['**/package.json', 'apps/desktop/package.json', true],
    ['src/sandbox/**', 'src/sandbox/a.ts', true], ['src/sandbox/**', 'src/sandbox/a/b.ts', true],
    ['src/sandbox/**', 'src/sandboxed.ts', false], ['src/sandbox/**', 'src/sandbox', false],
    ['tsconfig*.json', 'tsconfig.json', true], ['tsconfig*.json', 'tsconfig.build.json', true],
    ['tsconfig*.json', 'apps/x/tsconfig.json', false], ['**/Cargo.*', 'apps/desktop/src-tauri/Cargo.toml', true],
    ['**/*migration*', 'src/db/0001-migration.sql', true], ['.gitlab/**', '.gitlab/x/y.yaml', true],
    ['**/package.json', 'Package.json', false], ['src/**', 'src/a\nb.ts', true],
    ['a?.ts', 'ab.ts', true], ['a?.ts', 'a/b.ts', false],
  ])('matches %s against %s: %s', (glob, path, expected) => {
    expect(matchGlob(glob, path)).toBe(expected);
  });
});
