import { describe, it, expect } from 'vitest';
import { runPreflight, formatPreflightReport } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

function githubDoctor(overrides: Partial<DoctorCommand> = {}): DoctorCommand {
  return {
    kind: 'doctor',
    source: 'github',
    repoPath: '/repo',
    repoSlug: 'owner/repo',
    specLabel: 'ready for spec',
    agentLabel: 'ready for agent',
    needsInfoLabel: 'needs info',
    ...overrides,
  };
}

function makeRunner(labels: string[] = ['ready for spec', 'ready for agent', 'needs info', 'vanguard:speccing', 'vanguard:running', 'vanguard:review']): PreflightRunner {
  return async (cmd, args) => {
    if (cmd === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: '/repo' };
    if (cmd === 'git' && args.join(' ') === 'remote get-url origin') return { stdout: 'https://github.com/owner/repo.git' };
    if (cmd === 'docker' && args[0] === 'info') return { stdout: '' };
    if (cmd === 'docker' && args[0] === 'image') return { stdout: '' };
    if (cmd === 'gh' && args[0] === 'auth') return { stdout: '' };
    if (cmd === 'gh' && args[0] === 'label') return { stdout: JSON.stringify(labels.map((name) => ({ name }))) };
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('runPreflight', () => {
  it('fails before claim when LLM auth is missing', async () => {
    const report = await runPreflight(githubDoctor(), {
      env: { GH_TOKEN: 'gh' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: llm auth missing -> stop before claim');
  });

  it('fails when a GitHub loop label is missing', async () => {
    const report = await runPreflight(githubDoctor(), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(['ready for spec', 'ready for agent', 'needs info', 'vanguard:speccing', 'vanguard:running']),
    });

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: github labels missing vanguard:review -> stop before claim');
  });

  it('reports unreadable GitHub labels instead of throwing on malformed gh output', async () => {
    const report = await runPreflight(githubDoctor(), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: '/repo' };
        if (cmd === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/owner/repo.git' };
        if (cmd === 'docker') return { stdout: '' };
        if (cmd === 'gh' && args[0] === 'label') return { stdout: 'not-json' };
        return { stdout: '' };
      },
    });

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: github labels unreadable -> stop before claim');
  });

  it('prints compact ok lines when all GitHub checks pass', async () => {
    const report = await runPreflight(githubDoctor(), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    expect(report.ok).toBe(true);
    expect(formatPreflightReport(report)).toEqual([
      'preflight: node 24 ok',
      'preflight: llm auth ok',
      'preflight: repo remote ok',
      'preflight: docker daemon ok',
      'preflight: sandbox image ok',
      'preflight: github auth ok',
      'preflight: github labels ok',
    ]);
  });

  it('checks Linear API and skills before a Linear loop can run', async () => {
    const report = await runPreflight(
      {
        kind: 'doctor',
        source: 'linear',
        repoPath: '/repo',
        label: 'vanguard',
        specState: 'triage',
        specStateName: 'Spec',
        needsInfoState: 'Needs Info',
      },
      {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'token' },
        nodeVersion: '24.11.1',
        run: makeRunner(),
      },
    );

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: linear api missing -> stop before claim');
    expect(formatPreflightReport(report)).toContain('preflight: linear skills missing -> stop before claim');
  });
});
