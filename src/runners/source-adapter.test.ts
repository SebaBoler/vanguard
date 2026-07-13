import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProviderProxies } from '../sandbox/llm-proxy.js';
import { resolveVerifyCommand, runVerification } from '../pipeline/verify.js';
import { resolveAndRunVisualProof } from '../pipeline/visual-proof.js';
import { pickRunOptions, runSourcedIssue, conventionalCommitMessage } from './source-adapter.js';
import type { RunIssueDeps, SourceAdapter } from './source-adapter.js';
import type { Task } from '../tasks/fetcher.js';
import type { PipelineStage, StageOutcome } from '../pipeline/pipeline.js';
import type { RunEvent } from '../pipeline/events.js';

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
      flow: 'flow-b',
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
      flow: 'flow-b',
    });
  });

  it('copies maxTurns and maxRepairIterations when defined, omits when absent', () => {
    expect(pickRunOptions({ maxTurns: 80, maxRepairIterations: 5 })).toEqual({
      maxTurns: 80,
      maxRepairIterations: 5,
    });
    const withoutOverrides = pickRunOptions({});
    expect('maxTurns' in withoutOverrides).toBe(false);
    expect('maxRepairIterations' in withoutOverrides).toBe(false);
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
  { name: 'implementer', promptTemplate: '', maxTurns: 30 },
  { name: 'reviewer', promptTemplate: '', maxTurns: 20 },
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

  it('--plan swaps in the plan-implement-review pipeline (a dedicated planner stage runs first)', async () => {
    const adapter = fakeAdapter([], STAGES); // adapter's own stages are implementer→reviewer (no planner)
    await runSourcedIssue('group/project#1', { repoPath: '/repo', plan: true }, adapter);

    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled[0]?.name).toBe('planner'); // planning runs before the implementer
    expect(assembled.some((s) => s.name === 'implementer')).toBe(true);
  });

  it('--flow flow-b runs planner→implementer→adversary→repairer and reports the flow key', async () => {
    const events: RunEvent[] = [];
    const adapter = fakeAdapter([], STAGES);
    // Faithful mock: echo outcomes for the ACTUAL assembled stages (no synthetic 'reviewer'), so the
    // reviewer-less publish path is exercised — flow-b has adversary+repairer but no reviewer.
    runStages.mockImplementation(async (_ctx: unknown, stages: PipelineStage[]) => stages.map((s) => stageOutcome(s.name)));
    const result = await runSourcedIssue(
      'group/project#1',
      { repoPath: '/repo', flow: 'flow-b', onEvent: (e) => events.push(e) },
      adapter,
    );

    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.map((s) => s.name)).toEqual(['planner', 'implementer', 'adversary', 'repairer']);
    const runStart = events.find((e) => e.type === 'run-start');
    expect(runStart !== undefined && 'flow' in runStart ? runStart.flow : undefined).toBe('flow-b');
    // A reviewer-less flow completes and publishes the PR, but posts no verdict comment.
    expect(result.prUrl).toBe(MR_URL);
    expect(adapter.publishVerdict).not.toHaveBeenCalled();
  });

  it('--max-turns overrides only the implementer of an HCL-shaped flow; other stages survive', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo', flow: 'flow-b', maxTurns: 10 }, adapter);
    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.find((s) => s.name === 'implementer')?.maxTurns).toBe(10); // flag wins on implementer
    expect(assembled.find((s) => s.name === 'adversary')?.maxTurns).toBe(12); // non-implementer HCL value survives
  });

  it("--flow default keeps the adapter's own stages (Linear's issue-reading implementer survives)", async () => {
    // 'default' is a selectable name in capabilities().flows, so a name-driven UI will send it. It must
    // mean "the adapter's stages", NOT FLOWS.default.build — an adapter may customize them (Linear swaps
    // in an implementer that reads the issue via linear-cli), and overriding that is a silent regression.
    const linearish: PipelineStage[] = [
      { name: 'implementer', promptTemplate: 'Use the linear-cli skill to read Linear issue {{ISSUE}}', maxTurns: 30 },
      { name: 'reviewer', promptTemplate: '', maxTurns: 20 },
    ];
    const adapter = fakeAdapter([], linearish);
    await runSourcedIssue('VAN-1', { repoPath: '/repo', flow: 'default' }, adapter);

    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.find((s) => s.name === 'implementer')?.promptTemplate).toContain('linear-cli');
  });

  it('--conformance on a reviewer-less flow throws instead of running a stage nobody will see', async () => {
    // flow-b is adversary+repairer, no reviewer. The conformance narrative is published as a section of
    // the reviewer verdict comment, so without a reviewer it would run and surface nowhere.
    const adapter = fakeAdapter([], STAGES);
    await expect(
      runSourcedIssue('group/project#1', { repoPath: '/repo', flow: 'flow-b', conformance: true }, adapter),
    ).rejects.toThrow(/--conformance needs a flow with a reviewer stage/);
    expect(runStages).not.toHaveBeenCalled(); // rejected at assembly — no agent time burned
  });

  it('an unknown flow throws BEFORE the tracker fetch and any proxy/sandbox machinery (fail-fast)', async () => {
    const adapter = fakeAdapter([], STAGES);
    await expect(runSourcedIssue('group/project#1', { repoPath: '/repo', flow: 'nope' }, adapter)).rejects.toThrow(
      /unknown flow "nope" — choose one of: default, plan, flow-b/,
    );
    // a typo must cost nothing: no issue fetched, no provider proxies, no sandbox
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(vi.mocked(startProviderProxies)).not.toHaveBeenCalled();
  });

  it('--flow <name> resolves a repo .vanguard/flows/*.hcl flow and runs its lowered stages (S5)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'vg-sa-flows-'));
    try {
      await mkdir(join(repo, '.vanguard', 'flows'), { recursive: true });
      await writeFile(
        join(repo, '.vanguard', 'flows', 'my-flow.hcl'),
        'flow "my-flow" {\n  label = "Mine"\n\n  stage {\n    name = "implementer"\n    model = "special-model"\n  }\n}\n',
        'utf8',
      );
      const events: RunEvent[] = [];
      runStages.mockImplementation(async (_ctx: unknown, stages: PipelineStage[]) => stages.map((s) => stageOutcome(s.name)));
      await runSourcedIssue(
        'group/project#1',
        { repoPath: repo, flow: 'my-flow', onEvent: (e) => events.push(e) },
        fakeAdapter([], STAGES),
      );
      const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
      expect(assembled.map((s) => s.name)).toEqual(['implementer']);
      expect(assembled[0]?.model).toBe('special-model'); // HCL override over the library record
      expect((assembled[0]?.promptTemplate.length ?? 0) > 0).toBe(true); // identity from the library
      const runStart = events.find((e) => e.type === 'run-start');
      expect(runStart !== undefined && 'flow' in runStart ? runStart.flow : undefined).toBe('my-flow');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('--max-turns overrides the assembled implementer stage maxTurns; default stays 30 without the flag', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo', maxTurns: 80 }, adapter);
    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.find((s) => s.name === 'implementer')?.maxTurns).toBe(80);

    vi.clearAllMocks();
    runStages.mockResolvedValue([stageOutcome('reviewer')]);
    commitStage.mockResolvedValue({ committed: true, branch: 'b', sha: 'abc1234' });
    publishForReview.mockResolvedValue({ branch: 'b', prUrl: MR_URL });
    const adapter2 = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter2);
    const assembledNoOverride = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembledNoOverride.find((s) => s.name === 'implementer')?.maxTurns).toBe(30);
  });

  it('--max-turns survives the --plan pipeline', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo', plan: true, maxTurns: 80 }, adapter);
    const assembled = runStages.mock.calls[0]?.[1] as PipelineStage[];
    expect(assembled.find((s) => s.name === 'implementer')?.maxTurns).toBe(80);
  });

  it('persists stage outcomes WITH pr.prUrl on the committed path', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo' }, adapter);

    expect(persistStageOutcomes).toHaveBeenCalledTimes(1);
    expect(persistStageOutcomes.mock.calls[0]).toEqual(['/repo', [stageOutcome('reviewer')], MR_URL]);
  });

  it('white-label (--commit-author): no review comment, no issue link-back, clean PR body', async () => {
    const order: string[] = [];
    const adapter = fakeAdapter(order, STAGES);
    await runSourcedIssue(
      'group/project#1',
      { repoPath: '/repo', commitAuthor: { name: 'Sebastian Pietrzak', email: 's@p.co' } },
      adapter,
    );

    // Vanguard-branded surfaces are suppressed.
    expect(adapter.publishVerdict).not.toHaveBeenCalled();
    expect(adapter.linkPr).not.toHaveBeenCalled();
    expect(order).not.toContain('publishVerdict');
    expect(order).not.toContain('linkPr');
    // PR body is the plain Closes line — no "Vanguard", no "Proof of work" artifact.
    const body = (publishForReview.mock.calls[0]?.[1] as { body: string }).body;
    expect(body).not.toMatch(/Vanguard|Proof of work/);
    // Commit message is Conventional-Commits-safe (lower-case subject, trailing #issue).
    const message = (commitStage.mock.calls[0]?.[1] as { message: string }).message;
    expect(message).toBe('feat: t (#1)');
  });

  it('conventionalCommitMessage: lower-case subject, ≤100-char header, trailing #issue', () => {
    const title = 'CP: deleted CP is not fully removed (409 during adding CP with the name of deleted one)';
    const msg = conventionalCommitMessage(title, 'gh-pwc-pl-tax-itbc-data-controls-engine-904');
    expect(msg.length).toBeLessThanOrEqual(100);
    expect(msg.startsWith('feat: ')).toBe(true);
    expect(msg).toMatch(/\(#904\)$/);
    expect(msg.replace('feat: ', '')).not.toMatch(/[A-Z]/); // fully lower-case → passes commitlint subject-case
  });

  it('--base targets the PR at the given base branch', async () => {
    const adapter = fakeAdapter([], STAGES);
    await runSourcedIssue('group/project#1', { repoPath: '/repo', baseBranch: 'dev' }, adapter);

    const publishOpts = publishForReview.mock.calls[0]?.[1] as { baseBranch?: string };
    expect(publishOpts.baseBranch).toBe('dev');
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

  it('injects --spec-file content as a virtual comment without mutating the fetched task', async () => {
    const specPath = join(tmpdir(), `vanguard-specfile-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
    await writeFile(specPath, '<tech_spec>\nLOCAL SPEC BODY\n</tech_spec>', 'utf8');
    try {
      const adapter = fakeAdapter([], STAGES);
      await runSourcedIssue('group/project#1', { repoPath: '/repo', specFile: specPath }, adapter);
      const opts = runStages.mock.calls[0]?.[2] as { variables: Record<string, string> };
      expect(opts.variables.COMMENTS).toContain('LOCAL SPEC BODY');
      expect(task.comments).toHaveLength(0);
    } finally {
      await rm(specPath, { force: true });
    }
  });

  it('fails with a clear error when --spec-file cannot be read', async () => {
    const adapter = fakeAdapter([], STAGES);
    await expect(
      runSourcedIssue('group/project#1', { repoPath: '/repo', specFile: '/nonexistent/missing-spec.md' }, adapter),
    ).rejects.toThrow('--spec-file');
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

  it('white-label mode suppresses the issue signal (no label/comment leak) but still blocks the PR', async () => {
    const fakeJwt = 'eyJhbGciOiJSUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123';
    wmDiff.mockResolvedValueOnce(['diff --git a/src/x.ts b/src/x.ts', '+++ b/src/x.ts', `+const t = "${fakeJwt}";`].join('\n'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const adapter = fakeAdapter([], STAGES);
    const result = await runSourcedIssue(
      'group/project#1',
      { repoPath: '/repo', commitAuthor: { name: 'Sebastian Pietrzak', email: 's@p.co' } },
      adapter,
    );

    expect(result.prUrl).toBeUndefined();
    expect(result.secretBlocked).toBe(true);
    expect(adapter.signalSecretBlock).not.toHaveBeenCalled();
    expect(commitStage).not.toHaveBeenCalled();
    expect(publishForReview).not.toHaveBeenCalled();
    expect(persistStageOutcomes).toHaveBeenCalledTimes(1);
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
    expect(runAgent).toHaveBeenCalledTimes(2); // default MAX_REPAIR_ITERATIONS
    expect(adapter.addFailureLabel).toHaveBeenCalledWith(MR_URL, 'verify');
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain(`Part of ${task.id}`);
    expect(body).not.toContain(`Closes ${task.id}`);
  });

  it('--max-repair-iterations 5 allows up to 5 loop-back passes on persistent red verification', async () => {
    runStages.mockResolvedValueOnce([stageOutcome('implementer', 'sess-1'), stageOutcome('reviewer')]);
    vi.mocked(resolveVerifyCommand).mockResolvedValueOnce('npm test');
    vi.mocked(runVerification).mockResolvedValue({ passed: false } as never);
    runAgent.mockResolvedValue({ sessionId: 'sess-1' } as never);

    const adapter = fakeAdapter([], STAGES);
    const result = await runSourcedIssue('group/project#1', { repoPath: '/repo', maxRepairIterations: 5 }, adapter);

    expect(result.prUrl).toBe(MR_URL);
    expect(runAgent).toHaveBeenCalledTimes(5);
    expect(adapter.addFailureLabel).toHaveBeenCalledWith(MR_URL, 'verify');
    const body = publishForReview.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain(`Part of ${task.id}`);
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
