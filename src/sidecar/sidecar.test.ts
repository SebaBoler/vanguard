import { describe, expect, it } from 'vitest';
import { runSidecar, type SidecarDeps } from './sidecar.js';
import type { RunEvent } from '../pipeline/events.js';

async function* lines(...ls: string[]): AsyncIterable<string> {
  for (const l of ls) yield l;
}

function collect(): { write: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { write: (l) => out.push(l), out };
}

const stubDeps = (over: Partial<SidecarDeps> = {}): SidecarDeps => ({
  capabilities: () => ({ providers: ['claude'], flows: [{ name: 'default', label: 'D' }], transports: ['github', 'gitlab', 'linear'], defaults: { provider: 'claude', maxTurns: 30, maxCostUsd: 5, baseBranch: 'main' } }),
  createRun: async (_params, onEvent): Promise<{ prUrl?: string }> => {
    onEvent({ type: 'stage-start', name: 'implementer', index: 0, of: 1 } as RunEvent);
    return { prUrl: 'https://example/pr/1' };
  },
  ...over,
});

describe('runSidecar', () => {
  it('answers capabilities with a correlated result line', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'c1', method: 'capabilities' })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0].id).toBe('c1');
    expect(parsed[0].result.providers).toEqual(['claude']);
  });

  it('streams events then a result for createRun', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'r1', method: 'createRun', params: { issueRef: 'gh-1', repoPath: '/repo', flow: 'default', provider: 'claude' } })), write, stubDeps());
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ id: 'r1', event: { type: 'stage-start' } });
    expect(parsed[1]).toMatchObject({ id: 'r1', result: { prUrl: 'https://example/pr/1' } });
  });

  it('returns an error line for malformed JSON, does not throw', async () => {
    const { write, out } = collect();
    await runSidecar(lines('{not json'), write, stubDeps());
    expect(JSON.parse(out[0]!).error.kind).toBe('bad-request');
  });

  it('returns an error line for an unknown method', async () => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'x', method: 'nope' })), write, stubDeps());
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'x', error: { kind: 'bad-request' } });
  });

  it('rejects an unknown provider as bad-request, without invoking createRun', async () => {
    const { write, out } = collect();
    let called = false;
    const deps = stubDeps({
      createRun: async (): Promise<{ prUrl?: string }> => {
        called = true;
        return {};
      },
    });
    await runSidecar(lines(JSON.stringify({ id: 'p', method: 'createRun', params: { issueRef: 'gh-1', repoPath: '/repo', provider: 'notaprovider' } })), write, deps);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'p', error: { kind: 'bad-request' } });
    expect(called).toBe(false);
  });

  it.each([
    ['unknown transport', { issueRef: 'gh-1', repoPath: '/repo', transport: 'gitub' }],
    ['unknown flow', { issueRef: 'gh-1', repoPath: '/repo', flow: 'nope' }],
    ['prototype-key flow', { issueRef: 'gh-1', repoPath: '/repo', flow: 'toString' }],
    ['non-numeric maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: 'abc' }],
    ['non-positive maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: -5 }],
    ['fractional maxTurns', { issueRef: 'gh-1', repoPath: '/repo', maxTurns: 2.5 }],
    ['non-string baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: 42 }],
    ['blank baseBranch', { issueRef: 'gh-1', repoPath: '/repo', baseBranch: '  ' }],
    ['empty issueRef', { issueRef: '' }],
    ['whitespace issueRef', { issueRef: '  \n ' }],
    ['missing issueRef', {}],
    ['missing repoPath', { issueRef: 'gh-1' }],
    ['blank repoPath', { issueRef: 'gh-1', repoPath: '  ' }],
  ])('rejects %s as bad-request', async (_label, params) => {
    const { write, out } = collect();
    await runSidecar(lines(JSON.stringify({ id: 'b', method: 'createRun', params })), write, stubDeps());
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 'b', error: { kind: 'bad-request' } });
  });
});
