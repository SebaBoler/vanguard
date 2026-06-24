import { describe, it, expect, vi } from 'vitest';
import {
  watchOnce,
  specOnce,
  runLoopV1,
  githubProjectWatchPrimitives,
  githubSpecPrimitives,
  githubIssueWatchPrimitives,
  gitlabWatchPrimitives,
} from './watch.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { SpecWatchPrimitives, WatchPrimitives, WatchGitlabOptions } from './watch.js';
import type { GhRunner } from '../tasks/github.js';
import type { TaskFetcher } from '../tasks/fetcher.js';

describe('watchOnce', () => {
  it('claims, runs, reviews each ready issue and categorizes the outcomes', async () => {
    const calls: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        calls.push(`claim:${id}`);
        if (id === 'D') throw new Error('already taken');
      },
      runOne: async (id) => {
        calls.push(`run:${id}`);
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? {} : { prUrl: `pr/${id}` };
      },
      review: async (id) => {
        calls.push(`review:${id}`);
      },
      onFailure: async (id) => {
        calls.push(`fail:${id}`);
      },
    };

    const tick = await watchOnce(primitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['A']);
    expect(tick.noChange).toEqual(['B']);
    expect(tick.failed).toEqual(['C']);
    expect(tick.skipped).toEqual(['D']); // claim threw -> never run
    expect(calls).not.toContain('run:D');
    expect(calls.indexOf('claim:A')).toBeLessThan(calls.indexOf('run:A')); // claim precedes run
    expect(calls).toContain('review:A');
    expect(calls).not.toContain('review:B'); // no PR -> no review
    expect(calls).toContain('fail:C');
  });

  it('emits compact operator logs for each watch outcome', async () => {
    const logs: string[] = [];
    const primitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        if (id === 'D') throw new Error('already claimed');
      },
      runOne: async (id) => {
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? {} : { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await watchOnce(primitives, { concurrency: 1, log: (msg) => logs.push(msg) });

    expect(logs).toEqual([
      'watch: poll -> 4 ready',
      'watch A: claim -> running',
      'watch A: pr opened -> review',
      'watch B: claim -> running',
      'watch B: no change -> idle',
      'watch C: claim -> running',
      'watch C: failed -> failure noted',
      'watch D: skipped -> already claimed',
    ]);
  });
});

describe('specOnce', () => {
  it('emits compact operator logs for each spec outcome', async () => {
    const logs: string[] = [];
    const primitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        if (id === 'D') throw new Error('already claimed');
      },
      runSpec: async (id) => {
        if (id === 'B') return 'needs_info';
        if (id === 'C') throw new Error('boom');
        return 'advanced';
      },
      onFailure: async () => {},
    };

    await specOnce(primitives, { concurrency: 1, log: (msg) => logs.push(msg) });

    expect(logs).toEqual([
      'spec: poll -> 4 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec B: claim -> triage',
      'spec B: needs info -> waiting human',
      'spec C: claim -> triage',
      'spec C: failed -> retry later',
      'spec D: skipped -> already claimed',
    ]);
  });
});

describe('runLoopV1', () => {
  // T4 — continuous mode: freshly-advanced ticket is deferred (human-intervention window preserved)
  it('defers freshly-advanced tickets in continuous mode', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async () => {},
      runOne: async () => ({ prUrl: 'pr/B' }),
      review: async () => {
        controller.abort();
      },
      onFailure: async () => {},
    };

    await runLoopV1(
      specPrimitives,
      agentPrimitives,
      { once: false, signal: controller.signal, intervalMs: 0, concurrency: 1 },
      (msg) => logs.push(msg),
    );

    expect(logs).toEqual([
      'spec: poll -> 1 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec: 1 advanced, 0 needs-info, 0 failed, 0 skipped.',
      'watch: poll -> 1 ready',
      'watch B: claim -> running',
      'watch B: pr opened -> review',
      'watch: 1 PR(s), 0 no-change, 0 failed, 0 skipped.',
    ]);
  });

  it('exits promptly when the signal is aborted during a continuous tick', async () => {
    const controller = new AbortController();
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runOne: async () => {
        controller.abort();
        return {};
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await expect(
      Promise.race([
        runLoopV1(specPrimitives, agentPrimitives, { signal: controller.signal, intervalMs: 60_000 }, () => {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('loop did not stop after abort')), 100)),
      ]),
    ).resolves.toBeUndefined();
  });

  // T1 — once mode: just-advanced ticket is built even when listReady returns [] (index lag)
  it('once: true builds just-advanced ticket when listReady returns empty (simulates index lag)', async () => {
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true }, () => {});

    expect(builtIds).toEqual(['A']);
  });

  // T2 — once mode: no double-claim/run when the index also returns the just-advanced id
  it('once: true claims and builds each id exactly once when listReady also returns the advanced id', async () => {
    const claimed: string[] = [];
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }],
      claim: async (id) => {
        claimed.push(id);
      },
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, concurrency: 1 }, () => {});

    expect(claimed).toEqual(['A', 'B']);
    expect(builtIds).toEqual(['A', 'B']);
  });

  // T3 — once mode: needs-info tickets are NOT carried into the agent pass
  it('once: true does not build tickets the spec pass moved to needs-info', async () => {
    const builtIds: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'needs_info',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [],
      claim: async () => {},
      runOne: async (id) => {
        builtIds.push(id);
        return { prUrl: `pr/${id}` };
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true }, () => {});

    expect(builtIds).toEqual([]);
  });

  // T5 — once mode: operator log ordering includes the carried advanced id
  it('once: true emits spec logs then agent logs including the carried advanced id', async () => {
    const logs: string[] = [];
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'B' }],
      claim: async () => {},
      runOne: async () => ({ prUrl: 'pr/x' }),
      review: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(specPrimitives, agentPrimitives, { once: true, concurrency: 1 }, (msg) => logs.push(msg));

    expect(logs).toEqual([
      'spec: poll -> 1 ready',
      'spec A: claim -> triage',
      'spec A: advanced -> next poll agent',
      'spec: 1 advanced, 0 needs-info, 0 failed, 0 skipped.',
      'watch: poll -> 2 ready',
      'watch A: claim -> running',
      'watch A: pr opened -> review',
      'watch B: claim -> running',
      'watch B: pr opened -> review',
      'watch: 2 PR(s), 0 no-change, 0 failed, 0 skipped.',
    ]);
  });
});

describe('githubProjectWatchPrimitives', () => {
  const ITEM_LIST = JSON.stringify({
    items: [
      // trigger status + matching label -> ready
      { id: 'PVTI_1', status: 'Todo', content: { type: 'Issue', number: 1, repository: 'owner/repo', labels: ['vanguard'] } },
      // wrong status -> not ready
      { id: 'PVTI_2', status: 'In Progress', content: { type: 'Issue', number: 2, repository: 'owner/repo', labels: ['vanguard'] } },
      // trigger status but missing label -> not ready
      { id: 'PVTI_3', status: 'Todo', content: { type: 'Issue', number: 3, repository: 'owner/repo', labels: [] } },
      // trigger status, no label filter configured -> ready (tested below without label opt)
      { id: 'PVTI_4', status: 'Todo', content: { type: 'Issue', number: 4, repository: 'owner/repo', labels: [] } },
    ],
  });
  const PROJECT_VIEW = JSON.stringify({ id: 'PVT_project1' });
  const FIELD_LIST = JSON.stringify({
    fields: [
      {
        id: 'PVTSSF_status',
        name: 'Status',
        options: [
          { id: 'opt_todo', name: 'Todo' },
          { id: 'opt_inprogress', name: 'In Progress' },
          { id: 'opt_inreview', name: 'In Review' },
        ],
      },
    ],
  });

  function makeFakeGh(ghCalls: string[][]): GhRunner {
    return async (args: string[]): Promise<string> => {
      ghCalls.push(args);
      if (args[0] === 'project' && args[1] === 'item-list') return ITEM_LIST;
      if (args[0] === 'project' && args[1] === 'view') return PROJECT_VIEW;
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-edit') return '';
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      return '';
    };
  }

  it('listReady filters by trigger status and label', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready).toEqual([{ id: 'owner/repo#1' }]);
    expect(ghCalls.some((a) => a.includes('item-list'))).toBe(true);
  });

  it('listReady returns all trigger-status items when no label filter', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    const ready = await primitives.listReady();
    expect(ready.map((r) => r.id)).toEqual(['owner/repo#1', 'owner/repo#3', 'owner/repo#4']);
  });

  it('watchOnce wiring: claims ready items and calls item-edit for claim and review', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    // Stub runOne: only listReady -> claim -> run -> review wiring is tested here.
    const stubbedPrimitives = {
      ...primitives,
      runOne: async (_id: string) => ({ prUrl: 'https://github.com/owner/repo/pull/99' }),
    };

    const tick = await watchOnce(stubbedPrimitives, { concurrency: 1 });

    expect(tick.opened).toEqual(['owner/repo#1']);
    expect(tick.failed).toEqual([]);
    expect(tick.skipped).toEqual([]);

    // claim sets status to "In Progress" (opt_inprogress)
    const claimCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inprogress'));
    expect(claimCall).toBeDefined();
    expect(claimCall).toContain('PVTI_1');

    // review sets status to "In Review" (opt_inreview)
    const reviewCall = ghCalls.find((a) => a[1] === 'item-edit' && a.includes('opt_inreview'));
    expect(reviewCall).toBeDefined();
    expect(reviewCall).toContain('PVTI_1');
  });

  it('onFailure comments on the issue via gh', async () => {
    const ghCalls: string[][] = [];
    const primitives = githubProjectWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'test' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      projectNumber: 1,
      label: 'vanguard',
      triggerStatus: 'Todo',
      claimedStatus: 'In Progress',
      reviewStatus: 'In Review',
      gh: makeFakeGh(ghCalls),
    });

    await primitives.onFailure('owner/repo#1', new Error('agent exploded'));

    const commentCall = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(commentCall).toBeDefined();
    expect(commentCall).toContain('1'); // issue number
    const bodyIdx = commentCall?.indexOf('--body') ?? -1;
    expect(commentCall?.[bodyIdx + 1]).toContain('agent exploded');
  });
});

/** Build a minimal TaskFetcher stub for spec/agent primitives tests. */
function makeStubFetcher(listSpy: TaskFetcher['list']): TaskFetcher {
  return {
    fetch: vi.fn().mockResolvedValue({
      id: '1',
      title: 'T',
      description: 'D',
      labels: [],
      children: [],
      comments: [],
    }) as TaskFetcher['fetch'],
    list: listSpy,
  };
}

describe('githubSpecPrimitives ownerLabel', () => {
  it('listReady requests BOTH ownerLabel and specLabel when ownerLabel is set', async () => {
    const listSpy: TaskFetcher['list'] = vi.fn().mockResolvedValue([]);
    const fetcher = makeStubFetcher(listSpy);
    const primitives = githubSpecPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', fetcher } as never,
      repoSlug: 'owner/repo',
      specLabel: 'ready for spec',
      ownerLabel: 'vanguard',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      gh: vi.fn().mockResolvedValue(''),
    });

    await primitives.listReady();

    expect(listSpy).toHaveBeenCalledWith({ labels: ['vanguard', 'ready for spec'] });
  });

  it('listReady requests only specLabel when ownerLabel is absent', async () => {
    const listSpy: TaskFetcher['list'] = vi.fn().mockResolvedValue([]);
    const fetcher = makeStubFetcher(listSpy);
    const primitives = githubSpecPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', fetcher } as never,
      repoSlug: 'owner/repo',
      specLabel: 'ready for spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      gh: vi.fn().mockResolvedValue(''),
    });

    await primitives.listReady();

    expect(listSpy).toHaveBeenCalledWith({ labels: ['ready for spec'] });
  });
});

describe('githubIssueWatchPrimitives ownerLabel', () => {
  function makeGhSpy(): GhRunner {
    // gh issue list returns GitHubIssue[] where labels are objects with a name field
    return vi.fn().mockResolvedValue(
      JSON.stringify([{ number: 1, title: 'T', body: '', labels: [{ name: 'vanguard' }, { name: 'ready for agent' }] }]),
    );
  }

  it('listReady requests BOTH ownerLabel and label when ownerLabel is set', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      ownerLabel: 'vanguard',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    await primitives.listReady();

    const firstCall = (gh as ReturnType<typeof vi.fn>).mock.calls[0] as string[][] | undefined;
    const firstArgs = firstCall?.[0] ?? [];
    const labelIdx = firstArgs.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(firstArgs[labelIdx + 1]).toBe('vanguard,ready for agent');
  });

  it('listReady requests only label when ownerLabel is absent', async () => {
    const gh = makeGhSpy();
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'k' } as never, repoPath: '/tmp', repoSlug: 'owner/repo' },
      label: 'ready for agent',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      gh,
    });

    await primitives.listReady();

    const firstCall = (gh as ReturnType<typeof vi.fn>).mock.calls[0] as string[][] | undefined;
    const firstArgs = firstCall?.[0] ?? [];
    const labelIdx = firstArgs.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(firstArgs[labelIdx + 1]).toBe('ready for agent');
  });
});

describe('gitlabWatchPrimitives', () => {
  function makeGlab(responses: Record<string, string> = {}) {
    const calls: string[][] = [];
    const glab = async (args: string[]) => {
      calls.push(args);
      const key = `${args[0]}:${args[1]}`;
      return responses[key] ?? '[]';
    };
    return { glab, calls };
  }

  function makeOpts(project = 'g/p'): WatchGitlabOptions {
    return {
      deps: {
        repoPath: '/repo',
        project,
      } as unknown as WatchGitlabOptions['deps'],
      label: 'vanguard',
      claimedLabel: 'vanguard::running',
      reviewLabel: 'vanguard::review',
    };
  }

  it('listReady filters issues by label', async () => {
    const { glab } = makeGlab({
      'issue:list': JSON.stringify([
        { iid: 1, title: 'T', description: null, labels: ['vanguard'] },
      ]),
    });
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    const ready = await primitives.listReady();
    expect(ready).toHaveLength(1);
    expect(ready.at(0)?.id).toContain('#1');
  });

  it('claim adds claimedLabel and removes trigger label', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.claim('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain('vanguard::running');
    expect(updateCall).toContain('vanguard');
  });

  it('review adds reviewLabel', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.review('g/p#1');
    const updateCall = calls.find((c) => c[0] === 'issue' && c[1] === 'update');
    expect(updateCall).toContain('vanguard::review');
  });

  it('onFailure posts a comment', async () => {
    const { glab, calls } = makeGlab();
    const opts = makeOpts();
    const primitives = gitlabWatchPrimitives({ ...opts, gl: glab });
    await primitives.onFailure('g/p#1', new Error('boom'));
    const noteCall = calls.find((c) => c[0] === 'issue' && c[1] === 'note');
    expect(noteCall).toBeDefined();
    expect(noteCall?.some((arg) => arg.includes('boom'))).toBe(true);
  });
});
