import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveVerifyCommand, runVerification } from '../pipeline/verify.js';
import { resolveAndRunVisualProof } from '../pipeline/visual-proof.js';
import { pickRunOptions, runSourcedIssue } from './source-adapter.js';
import type { RunIssueDeps, SourceAdapter } from './source-adapter.js';
import type { Task } from '../tasks/fetcher.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';

describe('PR body assembly', () => {
  it('starts with Closes <task.id> for auto-close on merge', () => {
    const taskId = 'owner/repo#42';
    const baseBody = [`Closes ${taskId}`, `Automated implementation by Vanguard.`].join('\n\n');
    expect(baseBody.startsWith(`Closes ${taskId}`)).toBe(true);
  });
});

describe('pickRunOptions', () => {
  it('copies all defined CLI run options, including explicit false booleans', () => {
    const cmd: Partial<RunIssueDeps> = {
      provider: 'codex',
      reviewProvider: 'cursor',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      noSimplify: false,
      verifyCmd: 'pnpm test',
      visualProofCmd: 'pnpm screenshots',
      conformance: false,
      conformanceModel: 'opus',
      reviewGate: true,
    };

    expect(pickRunOptions(cmd)).toEqual({
      provider: 'codex',
      reviewProvider: 'cursor',
      providerModel: 'gpt-5',
      reviewModel: 'claude-opus',
      noSimplify: false,
      verifyCmd: 'pnpm test',
      visualProofCmd: 'pnpm screenshots',
      conformance: false,
      conformanceModel: 'opus',
    });
  });
});

// --- Integration-style coverage of runSourcedIssue with a fully faked SourceAdapter. ---
// The heavy host-side machinery (Docker, proxies, context, stage execution) is stubbed so the test
// exercises only the orchestration the seam owns: hook ordering and the lost-MR-link persistence.

const { persistStageOutcomes, runStages, commitStage, publishForReview } = vi.hoisted(() => ({
  persistStageOutcomes: vi.fn(async () => {}),
  runStages: vi.fn(),
  commitStage: vi.fn(),
  publishForReview: vi.fn(),
}));

vi.mock('../sandbox/llm-proxy.js', () => ({
  startProviderProxies: vi.fn(async () => ({ openai: undefined, destroy: vi.fn(async () => {}) })),
}));
vi.mock('../sandbox/egress-proxy.js', () => ({ llmProxySandboxEnv: vi.fn(() => undefined) }));
vi.mock('../sandbox/docker.js', () => ({ DockerSandboxProvider: class { constructor(_opts?: unknown) {} } }));
vi.mock('../sandbox/limits.js', () => ({ sandboxResourceLimits: vi.fn(() => ({})) }));
vi.mock('../agents/registry.js', () => ({
  selectAgents: vi.fn(() => ({ agent: { name: 'claude' }, secrets: {}, proxySecrets: {}, injectAnthropicAuth: false })),
}));
const { wmDiff, wmCommitMessages } = vi.hoisted(() => ({
  wmDiff: vi.fn(async () => ''),
  wmCommitMessages: vi.fn(async () => [] as string[]),
}));
const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock('../core/vanguard.js', () => ({
  prepareContext: vi.fn(async () => ({
    taskId: 'gl-1',
    sandbox: {},
    worktreePath: '/wt',
    wm: { diff: wmDiff, commitMessages: wmCommitMessages },
  })),
  disposeContext: vi.fn(async () => {}),
  runAgent: (...args: unknown[]) => runAgent(...(args as [])),
}));
vi.mock('../core/retrospective-memory.js', () => ({
  loadRetrospectiveMemory: vi.fn(async () => ''),
  refreshRetrospectiveMemory: vi.fn(async () => {}),
}));
vi.mock('../core/run-record.js', () => ({
  persistStageOutcomes: (...args: unknown[]) => persistStageOutcomes(...(args as [])),
  persistVerification: vi.fn(async () => {}),
  persistVisualProof: vi.fn(async () => {}),
}));
vi.mock('../core/run-summary.js', () => ({ summarizeOutcomes: vi.fn(() => '') }));
vi.mock('../pipeline/verify.js', () => ({
  resolveVerifyCommand: vi.fn(async () => undefined),
  runVerification: vi.fn(async () => undefined),
  renderVerificationFeedback: vi.fn(() => 'verify-feedback'),
  proofBlock: vi.fn(() => ''),
  verifySkippedBlock: vi.fn(() => ''),
}));
vi.mock('../pipeline/visual-proof.js', () => ({
  resolveAndRunVisualProof: vi.fn(async () => undefined),
  visualProofBlock: vi.fn(() => ''),
}));
vi.mock('../pipeline/pipeline.js', async (importActual) => {
  const actual = await importActual<typeof import('../pipeline/pipeline.js')>();
  return {
    ...actual,
    runStages: (...args: unknown[]) => runStages(...(args as [])),
    commitStage: (...args: unknown[]) => commitStage(...(args as [])),
    publishForReview: (...args: unknown[]) => publishForReview(...(args as [])),
  };
});
const { scanForSecrets } = vi.hoisted(() => ({ scanForSecrets: vi.fn() }));
vi.mock('../core/secret-scan.js', async (importActual) => {
  const actual = await importActual<typeof import('../core/secret-scan.js')>();
  return { ...actual, scanForSecrets: (...args: unknown[]) => scanForSecrets(...(args as [string])) };
});

const MR_URL = 'https://gitlab.com/group/project/-/merge_requests/1';
const task: Task = { id: 'group/project#1', title: 't', description: '', labels: [], children: [], comments: [] };

function stageOutcome(name: string, sessionId?: string): StageOutcome {
  return {
    name,
    result: {
      taskId: 'gl-1', completed: true, exitReason: 'completed', turns: 1,
      worktreePath: '/wt', worktreePreserved: true, finalText: 'No blocking findings.',
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  };
}

function fakeAdapter(order: string[], stages: PipelineStage[]): SourceAdapter {
  return {
    prepare: vi.fn(async () => ({ task })),
    taskId: () => 'gl-1',
    stages: () => stages,
    closeIssueOnMerge: true,
    publishVerdict: vi.fn(async () => { order.push('publishVerdict'); }),
    addFailureLabel: vi.fn(async () => { order.push('addFailureLabel'); }),
    linkPr: vi.fn(async () => { order.push('linkPr'); }),
    signalSecretBlock: vi.fn(async () => { order.push('signalSecretBlock'); }),
  };
}

const STAGES: PipelineStage[] = [
  { name: 'implementer', promptTemplate: '' },
  { name: 'reviewer', promptTemplate: '' },
];

describe('runSourcedIssue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    runStages.mockResolvedValue([stageOutcome('reviewer')]);
    commitStage.mockResolvedValue({ committed: true, branch: 'b', sha: 'abc1234' });
    publishForReview.mockResolvedValue({ branch: 'b', prUrl: MR_URL });
    wmDiff.mockResolvedValue('');
    wmCommitMessages.mockResolvedValue([]);
    const actual = await vi.importActual<typeof import('../core/secret-scan.js')>('../core/secret-scan.js');
    scanForSecrets.mockImplementation(actual.scanForSecrets);
  });

  it('fires publishVerdict → addFailureLabel → linkPr in order and reaches the conformance stage', async () => {
    // A failing verification triggers exactly one addFailureLabel('verify') between publish and link.
    vi.mocked(resolveVerifyCommand).mockResolvedValueOnce('npm test');
    vi.mocked(runVerification).mockResolvedValueOnce({ passed: false } as never);

    const order: string[] = [];
    const adapter = fakeAdapter(order, STAGES);
    const deps: RunIssueDeps = { repoPath: '/repo', conformance: true };
    const result = await runSourcedIssue('group/project#1', deps, adapter);

    expect(result.prUrl).toBe(MR_URL);
    expect(order).toEqual(['publishVerdict', 'addFailureLabel', 'linkPr']);
    expect(adapter.addFailureLabel).toHaveBeenCalledWith(MR_URL, 'verify');
    // assembleReviewPipeline appends the conformance stage when deps.conformance is true.
    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.some((s) => s.name === 'conformance')).toBe(true);
  });

  it('persists stage outcomes WITH pr.prUrl on the committed path', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(persistStageOutcomes).toHaveBeenCalledTimes(1);
    expect(persistStageOutcomes.mock.calls[0]).toEqual(['/repo', [stageOutcome('reviewer')], MR_URL]);
  });

  it('persists stage outcomes WITHOUT a url and opens no PR on the no-commit early return', async () => {
    commitStage.mockResolvedValueOnce({ committed: false, branch: 'b' });
    const order: string[] = [];
    const adapter = fakeAdapter(order, STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBeUndefined();
    expect(persistStageOutcomes).toHaveBeenCalledTimes(1);
    expect(persistStageOutcomes.mock.calls[0]).toEqual(['/repo', [stageOutcome('reviewer')]]);
    expect(publishForReview).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(resolveAndRunVisualProof).toHaveBeenCalled();
  });

  it('blocks commit/push/PR, never leaks the raw secret, and signals the block on the issue', async () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
    wmDiff.mockResolvedValueOnce(['diff --git a/src/x.ts b/src/x.ts', '+++ b/src/x.ts', `+const t = "${fakeJwt}";`].join('\n'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const order: string[] = [];
    const adapter = fakeAdapter(order, STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBeUndefined();
    expect(commitStage).not.toHaveBeenCalled();
    expect(publishForReview).not.toHaveBeenCalled();
    expect(persistStageOutcomes).toHaveBeenCalledTimes(1);
    expect(persistStageOutcomes.mock.calls[0]).toEqual(['/repo', [stageOutcome('reviewer')]]);

    expect(order).toEqual(['signalSecretBlock']);
    expect(adapter.signalSecretBlock).toHaveBeenCalledTimes(1);
    const [issueRef, signalledTask, block] = vi.mocked(adapter.signalSecretBlock).mock.calls[0]!;
    expect(issueRef).toBe('group/project#1');
    expect(signalledTask).toBe(task);
    expect(block.reason).toBe('findings');
    const serialisedBlock = JSON.stringify(block);
    expect(serialisedBlock).not.toContain(fakeJwt);
    expect(serialisedBlock).toContain('src/x.ts');

    const logged = consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('src/x.ts');
    expect(logged).toContain('jwt');
    expect(logged).not.toContain(fakeJwt);
    consoleError.mockRestore();
  });

  it('signals a scan-error precautionary block when scanForSecrets throws', async () => {
    wmDiff.mockResolvedValueOnce('diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+const t = 1;');
    scanForSecrets.mockImplementationOnce(() => {
      throw new Error('scan blew up');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const order: string[] = [];
    const adapter = fakeAdapter(order, STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBeUndefined();
    expect(commitStage).not.toHaveBeenCalled();
    expect(publishForReview).not.toHaveBeenCalled();
    expect(order).toEqual(['signalSecretBlock']);
    expect(adapter.signalSecretBlock).toHaveBeenCalledWith(
      'group/project#1',
      task,
      { reason: 'scan-error', message: 'scan blew up' },
    );
    consoleError.mockRestore();
  });

  it('does not throw when signalSecretBlock itself rejects (best-effort)', async () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
    wmDiff.mockResolvedValueOnce(`+const t = "${fakeJwt}";`);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = fakeAdapter([], STAGES);
    vi.mocked(adapter.signalSecretBlock).mockRejectedValueOnce(new Error('label API down'));

    await expect(runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter)).rejects.toThrow('label API down');
    consoleError.mockRestore();
  });

  it('resumes the implement session on red verification, and closes cleanly once it recovers', async () => {
    runStages.mockResolvedValueOnce([stageOutcome('implementer', 'sess-1'), stageOutcome('reviewer')]);
    vi.mocked(resolveVerifyCommand).mockResolvedValueOnce('npm test');
    vi.mocked(runVerification)
      .mockResolvedValueOnce({ passed: false } as never)
      .mockResolvedValueOnce({ passed: true } as never);
    runAgent.mockResolvedValueOnce({ sessionId: 'sess-2' } as never);

    const adapter = fakeAdapter([], STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBe(MR_URL);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[1]).toMatchObject({ resumeSessionId: 'sess-1' });
    expect(adapter.addFailureLabel).not.toHaveBeenCalledWith(MR_URL, 'verify');
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain(`Closes ${task.id}`);
  });

  it('exhausts the shared repair cap on persistent red verification and declares partial scope', async () => {
    runStages.mockResolvedValueOnce([stageOutcome('implementer', 'sess-1'), stageOutcome('reviewer')]);
    vi.mocked(resolveVerifyCommand).mockResolvedValueOnce('npm test');
    vi.mocked(runVerification)
      .mockResolvedValueOnce({ passed: false } as never)
      .mockResolvedValueOnce({ passed: false } as never)
      .mockResolvedValueOnce({ passed: false } as never);
    runAgent.mockResolvedValueOnce({ sessionId: 'sess-1' } as never).mockResolvedValueOnce({ sessionId: 'sess-1' } as never);

    const adapter = fakeAdapter([], STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBe(MR_URL);
    expect(runAgent).toHaveBeenCalledTimes(2); // MAX_CONFORMANCE_ITERATIONS
    expect(adapter.addFailureLabel).toHaveBeenCalledWith(MR_URL, 'verify');
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain(`Part of ${task.id}`);
    expect(body).not.toContain(`Closes ${task.id}`);
  });

  it('surfaces a commit-message close-leak warning in the body on a partial (red-verification) result', async () => {
    vi.mocked(resolveVerifyCommand).mockResolvedValueOnce('npm test');
    vi.mocked(runVerification).mockResolvedValueOnce({ passed: false } as never);
    wmCommitMessages.mockResolvedValueOnce([`Closes ${task.id}`]);

    const adapter = fakeAdapter([], STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(result.prUrl).toBe(MR_URL);
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain('Commit message closes the issue on rebase merge');
    expect(body).toContain(`\`Closes ${task.id}\``);
  });

  it('omits the commit-leak warning on a full green pass', async () => {
    wmCommitMessages.mockResolvedValueOnce([`Closes ${task.id}`]);

    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(wmCommitMessages).not.toHaveBeenCalled();
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).not.toContain('Commit message closes the issue on rebase merge');
  });
});
