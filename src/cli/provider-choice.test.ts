import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProviderChoice } from './provider-choice.js';

async function repoWith(customProviders: unknown): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'vg-choice-'));
  await mkdir(join(repo, '.vanguard'), { recursive: true });
  await writeFile(join(repo, '.vanguard', 'app.json'), JSON.stringify({ customProviders }));
  return repo;
}

const ENTRY = { name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY' };

describe('loadProviderChoice (the S6 dispatch entry block)', () => {
  it('loads customs from cmd.repoPath and resolves the custom name', async () => {
    const repoPath = await repoWith([ENTRY]);
    const choice = await loadProviderChoice({ repoPath, provider: 'my-proxy' });
    expect(choice.provider).toBe('my-proxy');
    expect(choice.customProviders?.[0]?.name).toBe('my-proxy');
  });

  it('unknown provider fails HERE — before any gc/auth/sandbox side effect — listing customs', async () => {
    const repoPath = await repoWith([ENTRY]);
    await expect(loadProviderChoice({ repoPath, provider: 'bogus' })).rejects.toThrow(/claude.*my-proxy/s);
  });

  it('a broken customs array does not break a built-in run (frozen contract)', async () => {
    const repoPath = await repoWith([{ name: 'bad' }]);
    await expect(loadProviderChoice({ repoPath, provider: 'claude' })).resolves.toMatchObject({ provider: 'claude' });
    await expect(loadProviderChoice({ repoPath })).resolves.toEqual(
      expect.objectContaining({ customProviders: expect.any(Array) }),
    );
  });

  it('re-runs the pairing checks the parser skipped: directOnly under --llm-proxy, collision', async () => {
    const repoPath = await repoWith([ENTRY]);
    await expect(loadProviderChoice({ repoPath, provider: 'my-proxy', llmProxy: true })).rejects.toThrow(
      /direct-mode only/,
    );
    await expect(loadProviderChoice({ repoPath, provider: 'my-proxy', reviewProvider: 'claude' })).rejects.toThrow(
      /share the anthropic transport/,
    );
  });

  it('http custom + --egress fails fast; without --egress it loads', async () => {
    const repoPath = await repoWith([{ ...ENTRY, baseUrl: 'http://nas.local:3456' }]);
    await expect(loadProviderChoice({ repoPath, provider: 'my-proxy', egress: true })).rejects.toThrow(
      /http:\/\/ endpoint/,
    );
    await expect(loadProviderChoice({ repoPath, provider: 'my-proxy' })).resolves.toBeDefined();
  });

  it('a repo with no customs yields a bare choice (no customProviders key)', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'vg-bare-'));
    const choice = await loadProviderChoice({ repoPath, provider: 'claude' });
    expect('customProviders' in choice).toBe(false);
  });
});
