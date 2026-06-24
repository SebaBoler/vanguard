import { describe, it, expect } from 'vitest';
import { gitlabMergeRequestWatchPrimitives, watchMergeRequestsOnce } from './mr-watch.js';

describe('gitlabMergeRequestWatchPrimitives', () => {
  function makeGlab(mrListJson = '[]', existingNotes = '[]') {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'mr' && args[1] === 'list') return mrListJson;
      if (args[0] === 'api') return existingNotes;
      return '';
    };
    return { glab, calls };
  }

  it('listReady returns non-draft, non-automation MRs with trigger label', async () => {
    const mrList = JSON.stringify([
      { iid: 1, title: 'T', draft: false, author: { username: 'alice' }, sha: 'abc', labels: ['ready for review'] },
      { iid: 2, title: 'T', draft: true, author: { username: 'alice' }, sha: 'xyz', labels: ['ready for review'] },
    ]);
    const { glab } = makeGlab(mrList);
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'vanguard::reviewing',
      reviewedLabel: 'vanguard::reviewed',
      glab,
      reviewOne: async () => {},
    });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.iid).toBe(1);
  });

  it('claim removes trigger label and adds reviewing label', async () => {
    const { glab, calls } = makeGlab();
    const primitives = gitlabMergeRequestWatchPrimitives({
      project: 'g/p',
      label: 'ready for review',
      reviewingLabel: 'vanguard::reviewing',
      reviewedLabel: 'vanguard::reviewed',
      glab,
      reviewOne: async () => {},
    });
    await primitives.claim({ project: 'g/p', iid: 1, title: 'T', draft: false, author: 'alice', sha: 'abc', labels: [] });
    const updateCall = calls.find((c) => c[0] === 'mr' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('vanguard::reviewing');
  });
});

describe('watchMergeRequestsOnce', () => {
  it('returns empty tick when no MRs ready', async () => {
    const primitives = {
      listReady: async () => [],
      claim: async () => {},
      review: async () => {},
      markReviewed: async () => {},
      onFailure: async () => {},
    };
    const tick = await watchMergeRequestsOnce(primitives);
    expect(tick.reviewed).toHaveLength(0);
    expect(tick.failed).toHaveLength(0);
  });
});
