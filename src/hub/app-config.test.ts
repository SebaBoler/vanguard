import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppConfig, readAppConfigStrict, writeAppConfig } from './app-config.js';

describe('app-config', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'vanguard-app-config-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('T-20 write then read round-trips several fields', async () => {
    await writeAppConfig(repoPath, {
      source: 'linear',
      label: 'vanguard-ready',
      concurrency: 3,
      budgetUsd: 2.5,
    });
    const back = await readAppConfig(repoPath);
    expect(back.source).toBe('linear');
    expect(back.label).toBe('vanguard-ready');
    expect(back.concurrency).toBe(3);
    expect(back.budgetUsd).toBe(2.5);
  });

  it('T-21 reading a repo with no app.json returns {} via both readAppConfig and readAppConfigStrict', async () => {
    const passive = await readAppConfig(repoPath);
    expect(passive).toEqual({});
    expect(passive.source).toBeUndefined();

    const strict = await readAppConfigStrict(repoPath);
    expect(strict).toEqual({});
    expect(strict.source).toBeUndefined();
  });

  it('T-22 readAppConfigStrict distinguishes absent vs invalid JSON vs directory', async () => {
    // (a) absent file -> resolves to {}
    await expect(readAppConfigStrict(repoPath)).resolves.toEqual({});

    // (b) invalid JSON -> throws, but passive readAppConfig still resolves to {}
    await mkdir(join(repoPath, '.vanguard'), { recursive: true });
    await writeFile(join(repoPath, '.vanguard', 'app.json'), '{not json');
    await expect(readAppConfigStrict(repoPath)).rejects.toThrow(/^\.vanguard\/app\.json is unreadable: /);
    await expect(readAppConfig(repoPath)).resolves.toEqual({});

    // (c) app.json existing as a directory -> throws
    const dirRepoPath = await mkdtemp(join(tmpdir(), 'vanguard-app-config-dir-'));
    try {
      await mkdir(join(dirRepoPath, '.vanguard', 'app.json'), { recursive: true });
      await expect(readAppConfigStrict(dirRepoPath)).rejects.toThrow(/^\.vanguard\/app\.json is unreadable: /);
    } finally {
      await rm(dirRepoPath, { recursive: true, force: true });
    }
  });

  it('T-23 customProviders round-trips arbitrary/unknown nested JSON content byte-for-byte', async () => {
    await mkdir(join(repoPath, '.vanguard'), { recursive: true });
    const rawJson =
      '{"label":"x","customProviders":[{"name":"my-proxy","baseUrl":"https://llm.example.com/api","keyEnv":"MY_KEY","model":"glm-5.2","futureKey":{"nested":true}}]}';
    await writeFile(join(repoPath, '.vanguard', 'app.json'), rawJson);

    const cfg = await readAppConfig(repoPath);
    await writeAppConfig(repoPath, cfg);

    const back = JSON.parse(await readFile(join(repoPath, '.vanguard', 'app.json'), 'utf8'));
    const entry = (back.customProviders as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(entry.name).toBe('my-proxy');
    expect(entry.keyEnv).toBe('MY_KEY');
    expect((entry.futureKey as Record<string, unknown>).nested).toBe(true);
  });
});
