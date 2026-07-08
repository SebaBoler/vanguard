import { describe, it, expect } from 'vitest';
import { specCommand } from './spec.js';
import type { Command } from './args.js';

type SpecCmd = Extract<Command, { kind: 'spec' }>;

function cmd(overrides: Partial<SpecCmd> = {}): SpecCmd {
  return { kind: 'spec', issueRef: 'o/r#7', repoPath: '/repo', egress: false, ...overrides };
}

describe('specCommand', () => {
  it('posts the branded spec comment by default', async () => {
    const posted: string[] = [];
    await specCommand(cmd(), {
      generateSpec: async () => 'Goal: build it',
      postComment: async (body) => {
        posted.push(body);
      },
      log: () => {},
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Vanguard tech spec:');
    expect(posted[0]).toContain('<tech_spec>\nGoal: build it\n</tech_spec>');
  });

  it('white-labels the comment under --commit-author (no "Vanguard" token), keeping the tech_spec tag', async () => {
    const posted: string[] = [];
    await specCommand(cmd({ commitAuthor: { name: 'S', email: 's@p.co' } }), {
      generateSpec: async () => 'Goal: build it',
      postComment: async (body) => {
        posted.push(body);
      },
      log: () => {},
    });
    expect(posted[0]).not.toContain('Vanguard');
    expect(posted[0]).toContain('Tech spec:');
    expect(posted[0]).toContain('<tech_spec>');
  });

  it('passes the issue ref and spec model through to the generator', async () => {
    const seen: Array<{ id: string; specModel?: string }> = [];
    await specCommand(cmd({ specModel: 'claude-fable-5' }), {
      generateSpec: async (id, deps) => {
        seen.push({ id, ...(deps.specModel !== undefined ? { specModel: deps.specModel } : {}) });
        return 's';
      },
      postComment: async () => {},
      log: () => {},
    });
    expect(seen).toEqual([{ id: 'o/r#7', specModel: 'claude-fable-5' }]);
  });

  it('throws a clear error for a bare issue number without --github-repo', async () => {
    await expect(
      specCommand(cmd({ issueRef: '7' }), {
        generateSpec: async () => 's',
        postComment: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow('--github-repo');
  });
});
