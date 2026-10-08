import { describe, it, expect } from 'vitest';
import { runCommand, watchCommand, runPresets, DEFAULT_PROVIDER } from './command';

describe('command builder', () => {
  it('defaults the provider to claude, never zai/--llm-proxy', () => {
    const cmd = runCommand({});
    expect(cmd).toContain('--provider claude');
    expect(DEFAULT_PROVIDER).toBe('claude');
    expect(cmd).not.toContain('--llm-proxy');
    expect(cmd).not.toContain('zai');
  });

  it('honors a configured provider', () => {
    expect(runCommand({ provider: 'codex' })).toContain('--provider codex');
    expect(watchCommand({ provider: 'zai' }, { source: 'github', concurrency: 3, loopV1: false })).toContain(
      '--provider zai',
    );
  });

  it('run uses the given source and lifts the turn cap', () => {
    expect(runCommand({}, 'gitlab')).toBe('vanguard run --gitlab <issue> --provider claude --max-turns 30');
  });

  it('run falls back to cfg.source, then github', () => {
    expect(runCommand({ source: 'linear' })).toContain('run --linear');
    expect(runCommand({})).toContain('run --github');
  });

  it('watch wires source/concurrency and only adds --loop-v1 when set', () => {
    expect(watchCommand({}, { source: 'github', concurrency: 5, loopV1: false })).toBe(
      'vanguard watch --github --concurrency 5 --provider claude --max-turns 30',
    );
    expect(watchCommand({}, { source: 'github', concurrency: 2, loopV1: true })).toContain('--loop-v1');
  });

  it('presets cover the three sources with the configured provider', () => {
    const presets = runPresets({ provider: 'codex' });
    // Pin label→source so a copy-paste swap (e.g. the GitLab preset emitting --github) fails.
    expect(presets).toEqual([
      { label: 'Run issue', cmd: 'vanguard run --github <issue> --provider codex --max-turns 30' },
      { label: 'Run (GitLab MR)', cmd: 'vanguard run --gitlab <issue> --provider codex --max-turns 30' },
      { label: 'Run (Linear)', cmd: 'vanguard run --linear <issue> --provider codex --max-turns 30' },
    ]);
  });
});
