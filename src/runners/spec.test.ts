import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  specOnce,
  runLoopV1,
  linearSpecPrimitives,
  githubSpecPrimitives,
  linearWatchPrimitives,
  githubIssueWatchPrimitives,
} from './watch.js';
import { runSpecGenerator } from './spec.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { SpecWatchPrimitives, WatchPrimitives, GenerateSpec } from './watch.js';
import type { Task, TaskFetcher } from '../tasks/fetcher.js';
import type { LinearCliRunner } from '../tasks/linear-cli.js';
import type { GhRunner } from '../tasks/github.js';
import type { RunSpecGeneratorDeps } from './spec.js';
import type { IsolatedSandboxProvider, ExecResult } from '../sandbox/provider.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from '../agents/provider.js';

/** A spec-ready task: description comfortably exceeds the triage minimum. */
function readyTask(id: string): Task {
  return {
    id,
    title: 'Add retry to the uploader',
    description: 'The uploader should retry transient 5xx errors up to three times with backoff.',
    labels: ['vanguard:spec'],
    children: [],
    comments: [],
  };
}

/** A vague task: description too short to spec. */
function vagueTask(id: string): Task {
  return { id, title: 'fix it', description: 'broken', labels: ['vanguard:spec'], children: [], comments: [] };
}

function fakeFetcher(tasks: Record<string, Task>, listed: Task[]): TaskFetcher {
  return {
    fetch: async (id) => {
      const task = tasks[id];
      if (task === undefined) throw new Error(`no task ${id}`);
      return task;
    },
    list: async () => listed,
  };
}

describe('specOnce', () => {
  it('claims, triages, and categorizes advanced / needs-info outcomes', async () => {
    const calls: string[] = [];
    const primitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      claim: async (id) => {
        calls.push(`claim:${id}`);
        if (id === 'D') throw new Error('already taken');
      },
      runSpec: async (id) => {
        calls.push(`spec:${id}`);
        if (id === 'C') throw new Error('boom');
        return id === 'B' ? 'needs_info' : 'advanced';
      },
      onFailure: async (id) => {
        calls.push(`fail:${id}`);
      },
    };

    const tick = await specOnce(primitives, { concurrency: 1 });

    expect(tick.advanced).toEqual(['A']);
    expect(tick.needsInfo).toEqual(['B']);
    expect(tick.failed).toEqual(['C']);
    expect(tick.skipped).toEqual(['D']); // claim threw -> never specced
    expect(calls).not.toContain('spec:D');
    expect(calls.indexOf('claim:A')).toBeLessThan(calls.indexOf('spec:A')); // claim precedes spec
    expect(calls).toContain('fail:C');
  });
});

describe('runLoopV1', () => {
  it('defers same-tick implementation in continuous mode: just-advanced id is NOT picked by the agent pass this tick', async () => {
    // Continuous mode: spec pass advances X. Agent pass's listReady returns both X (freshly advanced)
    // and Y (already in the agent trigger). X must be filtered out this tick; only Y runs.
    const ran: string[] = [];
    const controller = new AbortController();
    const specPrimitives: SpecWatchPrimitives = {
      listReady: async () => [{ id: 'X' }],
      claim: async () => {},
      runSpec: async () => 'advanced',
      onFailure: async () => {},
    };
    const agentPrimitives: WatchPrimitives = {
      listReady: async () => [{ id: 'X' }, { id: 'Y' }],
      claim: async () => {},
      runOne: async (id) => {
        ran.push(id);
        controller.abort(); // stop the loop after this tick
        return {};
      },
      review: async () => {},
      onFailure: async () => {},
    };

    await runLoopV1(
      specPrimitives,
      agentPrimitives,
      { once: false, signal: controller.signal, intervalMs: 0, concurrency: 1 },
      () => {},
    );

    expect(ran).toEqual(['Y']); // X deferred to next poll, Y implemented now
    expect(ran).not.toContain('X');
  });
});

describe('linearSpecPrimitives', () => {
  // linearSpecPrimitives builds its own LinearCliTaskFetcher; we drive its fetch()/triage through the
  // injected `linear` runner (which answers `issue view`), so tasks are supplied as CLI JSON.
  it('spec-ready task -> generates a spec, posts it, advances to the agent state', async () => {
    const task = readyTask('ENG-1');
    let generated = '';
    const generate: GenerateSpec = async (id) => {
      generated = `spec for ${id}`;
      return generated;
    };
    // linearSpecPrimitives.fetch goes through the injected linear runner; stub it to return the task.
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ identifier: task.id, title: task.title, description: task.description, labels: { nodes: task.labels.map((name) => ({ name })) } });
      return '[]';
    };
    const primitives = linearSpecPrimitives({
      deps: {} as unknown as RunSpecGeneratorDeps,
      label: 'vanguard:spec',
      specTriggerStateName: 'Spec',
      claimedState: 'Speccing',
      agentState: 'Todo',
      needsInfoState: 'Needs Info',
      linear,
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('advanced');
    expect(generated).toBe('spec for ENG-1');
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment).toBeDefined();
    expect(comment?.join(' ')).toContain('<tech_spec>');
    const advance = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Todo'));
    expect(advance).toBeDefined();
  });

  it('already-specced task -> skips generation and just advances (idempotent retry)', async () => {
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'unused';
    };
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          identifier: 'ENG-9',
          title: 'Add retry to the uploader',
          description: 'The uploader should retry transient 5xx errors up to three times with backoff.',
          comments: { nodes: [{ body: 'Vanguard tech spec:\n<tech_spec>\n## Problem\n</tech_spec>', user: { name: 'vanguard' } }] },
        });
      }
      return '[]';
    };
    const primitives = linearSpecPrimitives({
      deps: {} as unknown as RunSpecGeneratorDeps,
      label: 'vanguard:spec',
      specTriggerStateName: 'Spec',
      claimedState: 'Speccing',
      agentState: 'Todo',
      needsInfoState: 'Needs Info',
      linear,
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec('ENG-9');
    expect(outcome).toBe('advanced');
    expect(generateCalled).toBe(false); // no regeneration
    expect(calls.find((a) => a[0] === 'issue' && a[1] === 'comment')).toBeUndefined(); // no duplicate spec comment
    const advance = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Todo'));
    expect(advance).toBeDefined();
  });

  it('task with only an AC-heading comment (no <tech_spec tag) is NOT treated as already-specced', async () => {
    // A human-written comment with an "Acceptance Criteria" heading must NOT trigger the idempotency
    // skip (isVanguardSpec is strict; isSpecComment broad is only used for the agent gate).
    const task = readyTask('ENG-11');
    const acOnlyComment = '## Acceptance Criteria\n- [ ] Retry works.';
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'generated spec text';
    };
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          identifier: task.id,
          title: task.title,
          description: task.description,
          comments: { nodes: [{ body: acOnlyComment, user: { name: 'human' } }] },
        });
      }
      return '[]';
    };
    const primitives = linearSpecPrimitives({
      deps: {} as unknown as RunSpecGeneratorDeps,
      label: 'vanguard:spec',
      specTriggerStateName: 'Spec',
      claimedState: 'Speccing',
      agentState: 'Todo',
      needsInfoState: 'Needs Info',
      linear,
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('advanced');
    expect(generateCalled).toBe(true); // generation was NOT skipped
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('<tech_spec>'); // spec was posted
  });

  it('vague task -> clarify comment + needs-info, no spec generated', async () => {
    const task = vagueTask('ENG-2');
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'unused';
    };
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ identifier: task.id, title: task.title, description: task.description });
      return '[]';
    };
    const primitives = linearSpecPrimitives({
      deps: {} as unknown as RunSpecGeneratorDeps,
      label: 'vanguard:spec',
      specTriggerStateName: 'Spec',
      claimedState: 'Speccing',
      agentState: 'Todo',
      needsInfoState: 'Needs Info',
      linear,
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('needs_info');
    expect(generateCalled).toBe(false);
    const needsInfo = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Needs Info'));
    expect(needsInfo).toBeDefined();
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('too vague');
  });

  it('onFailure comments and reverts to the spec-trigger state', async () => {
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      return '[]';
    };
    const primitives = linearSpecPrimitives({
      deps: {} as unknown as RunSpecGeneratorDeps,
      label: 'vanguard:spec',
      specTriggerStateName: 'Spec',
      claimedState: 'Speccing',
      agentState: 'Todo',
      needsInfoState: 'Needs Info',
      linear,
    });

    await primitives.onFailure('ENG-3', new Error('sandbox died'));
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('sandbox died');
    const revert = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Spec'));
    expect(revert).toBeDefined();
  });
});

describe('githubSpecPrimitives', () => {
  function ghRecorder(calls: string[][]): GhRunner {
    return async (args) => {
      calls.push(args);
      return '';
    };
  }

  it('spec-ready task -> generates a spec, posts it, swaps to the agent label', async () => {
    const task = readyTask('owner/repo#1');
    const calls: string[][] = [];
    let generated = '';
    const generate: GenerateSpec = async (id) => {
      generated = `spec for ${id}`;
      return generated;
    };
    const primitives = githubSpecPrimitives({
      deps: { fetcher: fakeFetcher({ [task.id]: task }, [task]) } as unknown as RunSpecGeneratorDeps,
      repoSlug: 'owner/repo',
      specLabel: 'vanguard:spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'vanguard',
      needsInfoLabel: 'vanguard:needs-info',
      gh: ghRecorder(calls),
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('advanced');
    expect(generated).toBe('spec for owner/repo#1');
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('<tech_spec>');
    const advance = calls.find((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('vanguard') && a.includes('--add-label'));
    expect(advance).toBeDefined();
  });

  it('task with only an AC-heading comment (no <tech_spec tag) is NOT treated as already-specced', async () => {
    const task: Task = {
      ...readyTask('owner/repo#6'),
      comments: [{ author: 'human', body: '## Acceptance Criteria\n- [ ] Retry works.' }],
    };
    const calls: string[][] = [];
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'generated spec text';
    };
    const primitives = githubSpecPrimitives({
      deps: { fetcher: fakeFetcher({ [task.id]: task }, [task]) } as unknown as RunSpecGeneratorDeps,
      repoSlug: 'owner/repo',
      specLabel: 'vanguard:spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'vanguard',
      needsInfoLabel: 'vanguard:needs-info',
      gh: async (args) => { calls.push(args); return ''; },
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('advanced');
    expect(generateCalled).toBe(true); // generation was NOT skipped
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('<tech_spec>'); // spec was posted
  });

  it('already-specced task -> skips generation and just advances (idempotent retry)', async () => {
    const task: Task = {
      ...readyTask('owner/repo#5'),
      comments: [{ author: 'vanguard', body: '<tech_spec>\n## Problem\n</tech_spec>' }],
    };
    const calls: string[][] = [];
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'unused';
    };
    const primitives = githubSpecPrimitives({
      deps: { fetcher: fakeFetcher({ [task.id]: task }, [task]) } as unknown as RunSpecGeneratorDeps,
      repoSlug: 'owner/repo',
      specLabel: 'vanguard:spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'vanguard',
      needsInfoLabel: 'vanguard:needs-info',
      gh: ghRecorder(calls),
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('advanced');
    expect(generateCalled).toBe(false); // no regeneration
    expect(calls.find((a) => a[0] === 'issue' && a[1] === 'comment')).toBeUndefined(); // no duplicate spec comment
    const advance = calls.find((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('vanguard') && a.includes('--add-label'));
    expect(advance).toBeDefined();
  });

  it('vague task -> clarify comment + needs-info, no spec generated', async () => {
    const task = vagueTask('owner/repo#2');
    const calls: string[][] = [];
    let generateCalled = false;
    const generate: GenerateSpec = async () => {
      generateCalled = true;
      return 'unused';
    };
    const primitives = githubSpecPrimitives({
      deps: { fetcher: fakeFetcher({ [task.id]: task }, [task]) } as unknown as RunSpecGeneratorDeps,
      repoSlug: 'owner/repo',
      specLabel: 'vanguard:spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'vanguard',
      needsInfoLabel: 'vanguard:needs-info',
      gh: ghRecorder(calls),
      generateSpec: generate,
    });

    const outcome = await primitives.runSpec(task.id);
    expect(outcome).toBe('needs_info');
    expect(generateCalled).toBe(false);
    const needsInfo = calls.find((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('vanguard:needs-info'));
    expect(needsInfo).toBeDefined();
  });

  it('onFailure comments and restores the spec label', async () => {
    const calls: string[][] = [];
    const primitives = githubSpecPrimitives({
      deps: { fetcher: fakeFetcher({}, []) } as unknown as RunSpecGeneratorDeps,
      repoSlug: 'owner/repo',
      specLabel: 'vanguard:spec',
      claimedLabel: GITHUB_SPEC_CLAIMED_LABEL,
      agentLabel: 'vanguard',
      needsInfoLabel: 'vanguard:needs-info',
      gh: ghRecorder(calls),
    });

    await primitives.onFailure('owner/repo#3', new Error('boom'));
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('boom');
    const restore = calls.find((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('vanguard:spec') && a.includes('--add-label'));
    expect(restore).toBeDefined();
  });
});

describe('agent-pass triage gate', () => {
  it('github: vague agent ticket -> comment + needs-info, no implement (noChange)', async () => {
    const task = { ...vagueTask('owner/repo#9'), labels: ['vanguard'] };
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 9, title: task.title, body: task.description, labels: [{ name: 'vanguard' }] });
      return '';
    };
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, repoPath: '/tmp', repoSlug: 'owner/repo' } as never,
      label: 'vanguard',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      needsInfoLabel: 'vanguard:needs-info',
      gh,
    });

    const result = await primitives.runOne('owner/repo#9');
    expect(result.prUrl).toBeUndefined(); // noChange: no implement budget spent
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('acceptance criteria');
    const needsInfo = calls.find((a) => a[0] === 'issue' && a[1] === 'edit' && a.includes('vanguard:needs-info'));
    expect(needsInfo).toBeDefined();
  });

  it('github: well-specified ticket -> delegates to runOne (here: would call runGithubIssue)', async () => {
    // A task with real acceptance criteria passes the 'agent' gate, so the gate delegates. We assert
    // delegation by observing that the gate does NOT comment/needs-info and instead proceeds to fetch
    // + run (runGithubIssue will throw booting a real sandbox, which we treat as "delegated").
    const body = '## Acceptance Criteria\n- The uploader retries 5xx responses up to three times.\n';
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ number: 10, title: 'retry', body, labels: [{ name: 'vanguard' }] });
      return '';
    };
    const primitives = githubIssueWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, repoPath: '/tmp', repoSlug: 'owner/repo' } as never,
      label: 'vanguard',
      claimedLabel: GITHUB_CLAIMED_LABEL,
      reviewLabel: GITHUB_REVIEW_LABEL,
      needsInfoLabel: 'vanguard:needs-info',
      gh,
    });

    await expect(primitives.runOne('owner/repo#10')).rejects.toBeDefined();
    // Delegated: no clarification comment, no needs-info label swap.
    expect(calls.find((a) => a[0] === 'issue' && a[1] === 'comment')).toBeUndefined();
    expect(calls.find((a) => a.includes('vanguard:needs-info'))).toBeUndefined();
  });

  it('linear: vague agent ticket -> comment + needs-info, no implement (noChange)', async () => {
    const task = vagueTask('ENG-50');
    let viewed = false;
    const calls: string[][] = [];
    const linear: LinearCliRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        viewed = true;
        // runLinearIssue would call `issue view` too; this fake never reaches it because the gate
        // returns early on a vague ticket, so any view here is the triage fetch.
        return JSON.stringify({ identifier: task.id, title: task.title, description: task.description });
      }
      return '[]';
    };
    const primitives = linearWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, linearKey: 'k', repoPath: '/tmp', skillsDir: '/s' } as never,
      label: 'vanguard',
      claimedState: 'In Progress',
      reviewState: 'In Review',
      needsInfoState: 'Needs Info',
      linear,
    });

    const result = await primitives.runOne(task.id);
    expect(result.prUrl).toBeUndefined(); // noChange: runLinearIssue never ran, no implement budget spent
    expect(viewed).toBe(true); // the gate fetched the task to triage it
    const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
    expect(comment?.join(' ')).toContain('acceptance criteria');
    const needsInfo = calls.find((a) => a[0] === 'issue' && a[1] === 'update' && a.includes('Needs Info'));
    expect(needsInfo).toBeDefined();
  });

  it('linear: gate is absent when needsInfoState is unset (behaviour unchanged)', async () => {
    // Without needsInfoState, runOne must NOT fetch/triage — it goes straight to runLinearIssue.
    let fetched = false;
    const linear: LinearCliRunner = async (args) => {
      if (args[1] === 'view') fetched = true;
      return '[]';
    };
    const primitives = linearWatchPrimitives({
      deps: { auth: { type: 'api', apiKey: 'x' }, linearKey: 'k', repoPath: '/tmp', skillsDir: '/s' } as never,
      label: 'vanguard',
      claimedState: 'In Progress',
      reviewState: 'In Review',
      linear,
    });
    // runLinearIssue will throw booting a sandbox; we only assert no triage fetch happened first.
    await expect(primitives.runOne('ENG-99')).rejects.toBeDefined();
    expect(fetched).toBe(false);
  });
});

interface FakeSandbox {
  sandbox: IsolatedSandboxProvider;
  wasDestroyed: () => boolean;
}

function makeSandbox(): FakeSandbox {
  let destroyed = false;
  const sandbox = {
    id: 'fake',
    start: async (): Promise<void> => {},
    exec: async (command: string): Promise<ExecResult> => {
      if (command.includes('$HOME')) return { stdout: '/root', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    execStream: () => ({ stdout: (async function* () {})(), result: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }) }),
    copyIn: async (): Promise<void> => {},
    copyFileOut: async (): Promise<void> => {},
    exists: async (): Promise<boolean> => true,
    destroy: async (): Promise<void> => {
      destroyed = true;
    },
  } as unknown as IsolatedSandboxProvider;
  return { sandbox, wasDestroyed: () => destroyed };
}

function fakeAgent(finalText: string): AgentProvider {
  return {
    name: 'fake',
    async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      yield { text: finalText };
      return { finalText, turns: 1, sessionId: 's1' };
    },
  };
}

/** Recording agent: captures the model field from the first run() call, returns a valid spec. */
function recordingSpecAgent(captured: { model: string | undefined }): AgentProvider {
  const finalText = 'Here is the plan <tech_spec>\n## Problem\nRetry 5xx.\n</tech_spec> <promise>COMPLETE</promise>';
  return {
    name: 'recording',
    async *run(input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
      captured.model = input.model;
      yield { text: finalText };
      return { finalText, turns: 1, sessionId: 's1' };
    },
  };
}

describe('runSpecGenerator', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vg-spec-'));
    await execa('git', ['init', '-b', 'main'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), '# r');
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repo });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs the tech-spec stage, extracts the spec, persists with label "spec", disposes, opens no PR', async () => {
    const { sandbox, wasDestroyed } = makeSandbox();
    const task = readyTask('ENG-7');
    const finalText = 'Here is the plan <tech_spec>\n## Problem\nRetry 5xx.\n</tech_spec> <promise>COMPLETE</promise>';
    const deps: RunSpecGeneratorDeps = {
      auth: { type: 'api', apiKey: 'x' } as never,
      repoPath: repo,
      fetcher: fakeFetcher({ [task.id]: task }, [task]),
      sandboxFactory: () => sandbox,
      agent: fakeAgent(finalText),
    };

    const spec = await runSpecGenerator(task.id, deps);

    expect(spec).toContain('## Problem');
    expect(spec).not.toContain('<tech_spec>'); // extractTag strips the wrapper
    expect(wasDestroyed()).toBe(true); // context disposed in finally

    // Persisted with the 'spec' label (no PR/publish: runSpecGenerator imports neither
    // publishForReview nor commitStage, so no .diff/PR record is produced).
    const runsDir = join(repo, '.vanguard', 'runs', 'spec-eng-7');
    const files = await readdir(runsDir);
    expect(files.some((f) => f.endsWith('-spec.json'))).toBe(true);
  });

  it('throws (so onFailure runs) when the agent emits no <tech_spec> block', async () => {
    const { sandbox, wasDestroyed } = makeSandbox();
    const task = readyTask('ENG-8');
    const deps: RunSpecGeneratorDeps = {
      auth: { type: 'api', apiKey: 'x' } as never,
      repoPath: repo,
      fetcher: fakeFetcher({ [task.id]: task }, [task]),
      sandboxFactory: () => sandbox,
      agent: fakeAgent('no spec here <promise>COMPLETE</promise>'),
    };

    await expect(runSpecGenerator(task.id, deps)).rejects.toThrow(/tech_spec/i);
    expect(wasDestroyed()).toBe(true);
  });

  it('provider-aware spec model: zai -> undefined, claude -> haiku, explicit specModel always wins', async () => {
    const task = readyTask('ENG-20');

    async function runWithDeps(overrides: Partial<RunSpecGeneratorDeps>): Promise<string | undefined> {
      const captured: { model: string | undefined } = { model: 'NOT_SET' as string | undefined };
      const { sandbox } = makeSandbox();
      const deps: RunSpecGeneratorDeps = {
        auth: { type: 'api', apiKey: 'x' } as never,
        repoPath: repo,
        fetcher: fakeFetcher({ [task.id]: task }, [task]),
        sandboxFactory: () => sandbox,
        agent: recordingSpecAgent(captured),
        ...overrides,
      };
      await runSpecGenerator(task.id, deps);
      return captured.model;
    }

    // provider 'zai', no specModel -> model must be omitted (undefined) so ZaiProvider picks glm
    expect(await runWithDeps({ provider: 'zai' })).toBeUndefined();

    // no provider (claude default), no specModel -> model must be 'haiku' to keep spec pass cheap
    expect(await runWithDeps({})).toBe('haiku');

    // explicit specModel always wins regardless of provider
    expect(await runWithDeps({ provider: 'zai', specModel: 'sonnet' })).toBe('sonnet');
  });
});
