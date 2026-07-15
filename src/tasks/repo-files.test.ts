import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoFile, resolveRepoFile } from './repo-files.js';

const repo = (): string => mkdtempSync(join(tmpdir(), 'vg-repo-'));

test('reads a normal repo-relative file', async () => {
  const r = repo();
  writeFileSync(join(r, 'notes.md'), 'hello');
  const res = await readRepoFile(r, 'notes.md');
  expect(res.content).toBe('hello');
  expect(res.truncated).toBe(false);
});

test('rejects lexical traversal and absolute paths', () => {
  const r = repo();
  expect(() => resolveRepoFile(r, '../outside')).toThrow(/escapes|invalid/);
  expect(() => resolveRepoFile(r, '/etc/passwd')).toThrow(/invalid/);
  expect(() => resolveRepoFile(r, 'a/../../b')).toThrow(/escapes/);
});

test('a symlink pointing out of the repo is refused, not followed (review r2 security)', async () => {
  // A tracked symlink (or a free-typed mention of one) passes the lexical check; readRepoFile must
  // canonicalize and refuse it — following it would inline an arbitrary host file into the prompt.
  const r = repo();
  const outside = mkdtempSync(join(tmpdir(), 'vg-outside-'));
  writeFileSync(join(outside, 'secret'), 'do not exfiltrate');
  symlinkSync(join(outside, 'secret'), join(r, 'notes.md'));
  await expect(readRepoFile(r, 'notes.md')).rejects.toThrow(/escapes the repo/);
});

test('a symlinked DIRECTORY out of the repo is refused too', async () => {
  const r = repo();
  const outside = mkdtempSync(join(tmpdir(), 'vg-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(r, 'linked'));
  await expect(readRepoFile(r, 'linked/secret.txt')).rejects.toThrow(/escapes the repo/);
});

test('a symlink WITHIN the repo is fine', async () => {
  const r = repo();
  mkdirSync(join(r, 'docs'));
  writeFileSync(join(r, 'docs', 'real.md'), 'in-repo');
  symlinkSync(join(r, 'docs', 'real.md'), join(r, 'alias.md'));
  const res = await readRepoFile(r, 'alias.md');
  expect(res.content).toBe('in-repo');
});
