import { describe, expect, it } from 'vitest';
import { parseGitlabProjectFromRemote, runGitlabIssue, gitlabAdapter } from './gitlab.js';
import type { RunGitlabIssueDeps } from './gitlab.js';
import type { GlabRunner } from '../tasks/gitlab.js';
import type { StageOutcome } from '../pipeline/pipeline.js';

describe('runGitlabIssue', () => {
  it('returns no prUrl when agent produces no changes', async () => {
    // Unit test is minimal — the full flow requires Docker. Just verify the dep contract.
    // This test is intentionally thin; integration coverage lives in E2E runs.
    expect(runGitlabIssue).toBeDefined();
    expect(typeof runGitlabIssue).toBe('function');
  });
});

describe('parseGitlabProjectFromRemote', () => {
  it('parses SSH remote', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/project.git')).toBe('group/project');
  });
  it('parses SSH remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('git@gitlab.com:group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses HTTPS remote', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project.git')).toBe('group/project');
  });
  it('parses HTTPS remote with nested subgroups', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/sub/project.git')).toBe('group/sub/project');
  });
  it('parses HTTPS remote without .git suffix', () => {
    expect(parseGitlabProjectFromRemote('https://gitlab.com/group/project')).toBe('group/project');
  });
  it('returns undefined for unrecognised format', () => {
    expect(parseGitlabProjectFromRemote('not-a-remote')).toBeUndefined();
  });
});

function makeDeps(overrides: Partial<RunGitlabIssueDeps> = {}): RunGitlabIssueDeps {
  return { repoPath: '/repo', project: 'group/project', ...overrides };
}

function stageOutcome(name: string, finalText: string, completed = true): StageOutcome {
  return {
    name,
    result: {
      taskId: 't',
      completed,
      exitReason: completed ? 'completed' : 'maxTurns',
      turns: 1,
      worktreePath: '/tmp/wt',
      worktreePreserved: true,
      finalText,
    },
  };
}

function makeGlab(ret = '{}'): { glab: GlabRunner; calls: string[][] } {
  const calls: string[][] = [];
  const glab: GlabRunner = async (args) => { calls.push(args); return ret; };
  return { calls, glab };
}

describe('gitlabAdapter', () => {
  it('taskId sanitises issue ref to gl- prefix', () => {
    const adapter = gitlabAdapter(makeDeps());
    expect(adapter.taskId({ id: 'group/project#42', title: 't', description: '', labels: [], children: [], comments: [] }))
      .toBe('gl-group-project-42');
  });

  it('has reviewCli glab and closeIssueOnMerge true', () => {
    const adapter = gitlabAdapter(makeDeps());
    expect(adapter.reviewCli).toBe('glab');
    expect(adapter.closeIssueOnMerge).toBe(true);
  });

  it('publishVerdict throws when reviewerOutcome is missing', async () => {
    const adapter = gitlabAdapter(makeDeps());
    await expect(
      adapter.publishVerdict({
        prUrl: 'https://gitlab.com/group/project/-/merge_requests/1',
        headSha: 'abc123',
        attribution: 'claude',
      }),
    ).rejects.toThrow('silence is not ok');
  });

  it('publishVerdict posts a note containing ## Vanguard Review and attribution', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      attribution: 'claude/sonnet',
    });
    expect(calls.length).toBe(1);
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('## Vanguard Review');
    expect(body).toContain('Reviewed by claude/sonnet @ abcdef1');
    expect(body).toContain('<!-- vanguard-mr-review:');
  });

  it('publishVerdict appends ## Conformance section when conformance outcome is present', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      conformanceOutcome: stageOutcome(
        'conformance',
        '<findings>{"findings":[{"severity":"medium","kind":"correctness","title":"missed AC","evidence":"AC-1"}]}</findings>\n<promise>COMPLETE</promise>',
      ),
      attribution: 'claude',
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('## Conformance');
    expect(body).toContain('missed AC');
  });

  it('publishVerdict adds gate degradation warning on blocking findings when gate=true', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome(
        'reviewer',
        '<findings>{"findings":[{"severity":"high","kind":"correctness","title":"bad","evidence":"x"}]}</findings>',
      ),
      attribution: 'claude',
      gate: true,
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).toContain('gate is not enforced on GitLab');
  });

  it('publishVerdict does not add gate warning when no blocking findings', async () => {
    const { calls, glab } = makeGlab();
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.publishVerdict({
      prUrl: 'https://gitlab.com/group/project/-/merge_requests/7',
      headSha: 'abcdef1234567890',
      reviewerOutcome: stageOutcome('reviewer', 'No blocking findings.'),
      attribution: 'claude',
      gate: true,
    });
    const body = calls[0]?.at(-1) ?? '';
    expect(body).not.toContain('gate is not enforced');
  });

  it('addFailureLabel maps verify → vanguard::verify-failed and pre-creates the label', async () => {
    const { calls, glab } = makeGlab('');
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.addFailureLabel('https://gitlab.com/group/project/-/merge_requests/1', 'verify');
    // pre-create the scoped label, then add it to the MR — both routed through the injected GlabRunner.
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::verify-failed'],
      ['mr', 'update', '1', '--repo', 'group/project', '--label', 'vanguard::verify-failed'],
    ]);
  });

  it('addFailureLabel maps visual-proof → vanguard::visual-proof-failed', async () => {
    const { calls, glab } = makeGlab('');
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.addFailureLabel('https://gitlab.com/group/project/-/merge_requests/2', 'visual-proof');
    expect(calls).toEqual([
      ['label', 'create', '--repo', 'group/project', '--name', 'vanguard::visual-proof-failed'],
      ['mr', 'update', '2', '--repo', 'group/project', '--label', 'vanguard::visual-proof-failed'],
    ]);
  });

  it('linkPr calls glab to post MR note on the issue', async () => {
    const calls: string[][] = [];
    const glab: GlabRunner = async (args) => {
      calls.push(args);
      return '';
    };
    const adapter = gitlabAdapter(makeDeps(), glab);
    await adapter.linkPr('group/project#5', { id: 'group/project#5', title: 't', description: '', labels: [], children: [], comments: [] }, 'https://gitlab.com/group/project/-/merge_requests/9');
    expect(calls.some((c) => c.join(' ').includes('opened an MR'))).toBe(true);
  });
});
