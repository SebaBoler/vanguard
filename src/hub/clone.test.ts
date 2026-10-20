import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cloneProject, cloneUrlHost, repoNameFromUrl, type CloneExec } from './clone.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'clone-test-'));
  roots.push(path);
  return path;
}

const result = { stdout: '', stderr: '' };

test('rejects symlink destinations, including dangling links, before executing', async () => {
  const browseRoot = await root();
  const outside = await root();
  const exec = vi.fn<CloneExec>().mockResolvedValue(result);
  for (const [name, target] of [['escape', outside], ['dangling', join(outside, 'missing')]]) {
    await symlink(target!, join(browseRoot, name!));
    await expect(cloneProject(browseRoot, { url: 'https://gitlab.com/org/repo.git', parentDir: browseRoot, name }, { exec }))
      .rejects.toThrow('symbolic link');
  }
  expect(exec).not.toHaveBeenCalled();
});

test('rejects escaped parents, unsafe names and occupied destinations', async () => {
  const browseRoot = await root();
  const outside = await root();
  const exec = vi.fn<CloneExec>().mockResolvedValue(result);
  await symlink(outside, join(browseRoot, 'parent'));
  await mkdir(join(browseRoot, 'occupied'));
  await writeFile(join(browseRoot, 'occupied', 'file'), 'data');
  for (const params of [
    { parentDir: outside }, { parentDir: join(browseRoot, 'parent') },
    { parentDir: browseRoot, name: '../escape' }, { parentDir: browseRoot, name: 'occupied' },
  ]) {
    await expect(cloneProject(browseRoot, { url: 'https://gitlab.com/org/repo.git', ...params }, { exec })).rejects.toThrow();
  }
  expect(exec).not.toHaveBeenCalled();
});

test('clones into an empty directory and preserves defaults when extending hosts', async () => {
  const browseRoot = await root();
  await mkdir(join(browseRoot, 'repo'));
  const exec = vi.fn<CloneExec>().mockResolvedValue(result);
  for (const url of ['https://gitlab.com/org/repo.git', 'ssh://git@internal.example/org/repo.git']) {
    await expect(cloneProject(browseRoot, { url, parentDir: browseRoot }, { exec, allowedHosts: ['internal.example'] }))
      .resolves.toBe(join(browseRoot, 'repo'));
    expect(exec).toHaveBeenLastCalledWith('git', ['clone', url, join(browseRoot, 'repo')], expect.objectContaining({ timeout: 600_000 }));
  }
});

test('checks GitHub authentication for the correct host and falls back to git', async () => {
  const browseRoot = await root();
  const exec = vi.fn<CloneExec>().mockResolvedValue(result);
  const params = { url: 'https://github.com/org/repo.git', parentDir: browseRoot };
  await cloneProject(browseRoot, params, { exec });
  expect(exec).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 10_000 });
  expect(exec).toHaveBeenLastCalledWith('gh', ['repo', 'clone', params.url, join(browseRoot, 'repo')], expect.anything());
  exec.mockRejectedValueOnce(new Error('not authenticated'));
  await cloneProject(browseRoot, params, { exec });
  expect(exec).toHaveBeenLastCalledWith('git', ['clone', params.url, join(browseRoot, 'repo')], expect.anything());
});

test('rejects unsupported, ambiguous and unapproved URLs before executing', async () => {
  const browseRoot = await root();
  const exec = vi.fn<CloneExec>().mockResolvedValue(result);
  for (const url of ['file:///tmp/repo', '/tmp/repo', 'https://evil.example/repo', 'https://github.com\\@evil.example/repo', 'https://git\nhub.com/org/repo', 'https:github.com/org/repo']) {
    await expect(cloneProject(browseRoot, { url, parentDir: browseRoot }, { exec })).rejects.toThrow();
  }
  expect(exec).not.toHaveBeenCalled();
  expect(cloneUrlHost('git@github.com:org/repo.git')).toBe('github.com');
});

test('derives folder names from paths without query strings or fragments', () => {
  for (const url of ['https://gitlab.com/org/repo.git?ref=main#readme', 'ssh://git@gitlab.com/org/repo.git/', 'git@gitlab.com:org/repo.git']) {
    expect(repoNameFromUrl(url)).toBe('repo');
  }
  expect(() => repoNameFromUrl('https://github.com/')).toThrow('cannot derive');
});

test('streams progress and surfaces subprocess failures', async () => {
  const browseRoot = await root();
  const onProgress = vi.fn();
  const exec: CloneExec = async (_file, _args, options) => {
    options?.onLine?.('receiving objects');
    throw { stderr: ' repository not found ' };
  };
  await expect(cloneProject(browseRoot, { url: 'https://gitlab.com/org/repo.git', parentDir: browseRoot }, { exec, onProgress }))
    .rejects.toThrow('git clone failed: repository not found');
  expect(onProgress).toHaveBeenCalledWith('receiving objects');
});
