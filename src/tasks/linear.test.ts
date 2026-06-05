import { describe, it, expect } from 'vitest';
import { LinearTaskFetcher } from './linear.js';
import type { LinearClientLike } from './linear.js';

function fakeClient(): LinearClientLike {
  const issue = {
    id: 'uuid-1',
    identifier: 'LOBE-1',
    title: 'Fix login',
    description: 'Body here',
    labels: async (): Promise<{ nodes: Array<{ name: string }> }> => ({ nodes: [{ name: 'bug' }, { name: 'p1' }] }),
  };
  return {
    issue: async (id: string) => ({ ...issue, id }),
    issues: async () => ({ nodes: [issue] }),
  };
}

describe('LinearTaskFetcher', () => {
  it('maps an issue to a Task (identifier preferred over uuid)', async () => {
    const task = await new LinearTaskFetcher(fakeClient()).fetch('LOBE-1');
    expect(task).toEqual({ id: 'LOBE-1', title: 'Fix login', description: 'Body here', labels: ['bug', 'p1'] });
  });

  it('lists tasks and filters by label', async () => {
    const all = await new LinearTaskFetcher(fakeClient()).list();
    expect(all).toHaveLength(1);
    const none = await new LinearTaskFetcher(fakeClient()).list({ labels: ['nope'] });
    expect(none).toHaveLength(0);
  });
});
