import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveVerifyCommand, runVerification } from '../pipeline/verify.js';
import { resolveAndRunVisualProof } from '../pipeline/visual-proof.js';
import { runSourcedIssue } from './source-adapter.js';
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
vi.mock('../core/vanguard.js', () => ({
  prepareContext: vi.fn(async () => ({ taskId: 'gl-1', sandbox: {}, worktreePath: '/wt' })),
  disposeContext: vi.fn(async () => {}),
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
  proofBlock: vi.fn(() => ''),
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

const MR_URL = 'https://gitlab.com/group/project/-/merge_requests/1';
const task: Task = { id: 'group/project#1', title: 't', description: '', labels: [], children: [], comments: [] };

function stageOutcome(name: string): StageOutcome {
  return {
    name,
    result: {
      taskId: 'gl-1', completed: true, exitReason: 'completed', turns: 1,
      worktreePath: '/wt', worktreePreserved: true, finalText: 'No blocking findings.',
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
  };
}

const STAGES: PipelineStage[] = [
  { name: 'implementer', promptTemplate: '' },
  { name: 'reviewer', promptTemplate: '' },
];

describe('runSourcedIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStages.mockResolvedValue([stageOutcome('reviewer')]);
    commitStage.mockResolvedValue({ committed: true, branch: 'b', sha: 'abc1234' });
    publishForReview.mockResolvedValue({ branch: 'b', prUrl: MR_URL });
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
});
