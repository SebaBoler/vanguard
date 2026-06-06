import { describe, it, expect } from 'vitest';
import { LinearCliTaskFetcher } from './linear-cli.js';
import type { LinearCliRunner } from './linear-cli.js';

const issue = { identifier: 'ENG-12', title: 'Fix oauth', description: 'body', labels: [{ name: 'bug' }, 'p1'] };

function runner(payload: unknown): LinearCliRunner {
  return async (): Promise<string> => JSON.stringify(payload);
}

describe('LinearCliTaskFetcher', () => {
  it('maps an issue from a JSON array', async () => {
    const task = await new LinearCliTaskFetcher({ linear: runner([issue]) }).fetch('ENG-12');
    expect(task).toEqual({ id: 'ENG-12', title: 'Fix oauth', description: 'body', labels: ['bug', 'p1'] });
  });

  it('tolerates a {nodes:[...]} wrapper and filters by label', async () => {
    const fetcher = new LinearCliTaskFetcher({ linear: runner({ nodes: [issue] }) });
    expect(await fetcher.list()).toHaveLength(1);
    expect(await fetcher.list({ labels: ['nope'] })).toHaveLength(0);
  });

  it('throws when the issue is not found', async () => {
    await expect(new LinearCliTaskFetcher({ linear: runner([]) }).fetch('ENG-99')).rejects.toThrow(/not found/);
  });
});
