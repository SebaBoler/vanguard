import { describe, it, expect } from 'vitest';
import { runPreflight, formatPreflightReport } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;
type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;

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

function doctorPrs(overrides: Partial<DoctorPrsCommand> = {}): DoctorPrsCommand {
  return {
    kind: 'doctor-prs',
    repoPath: '/repo',
    repoSlug: 'owner/repo',
    label: 'ready for vanguard review',
    reviewingLabel: 'vanguard:reviewing',
    reviewedLabel: 'vanguard:reviewed',
    ...overrides,
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

  it('checks PR review loop labels before watch-prs can claim a PR', async () => {
    const report = await runPreflight(doctorPrs(), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(['ready for vanguard review', 'vanguard:reviewing']),
    });

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: github labels missing vanguard:reviewed -> stop before claim');
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

  it('fails provider auth when doctor uses codex but CODEX_API_KEY/OPENAI_API_KEY are absent', async () => {
    const report = await runPreflight(githubDoctor({ provider: 'codex' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    expect(report.ok).toBe(false);
    const lines = formatPreflightReport(report);
    const providerAuthLine = lines.find((l) => l.includes('provider auth'));
    expect(providerAuthLine).toBeDefined();
    expect(providerAuthLine).toContain('-> stop before claim');
    const providerCheck = report.checks.find((c) => c.name === 'provider auth');
    expect(providerCheck?.ok).toBe(false);
  });

  it('passes provider auth when doctor uses codex and CODEX_API_KEY is set', async () => {
    const report = await runPreflight(githubDoctor({ provider: 'codex' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_API_KEY: 'sk-test' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    const providerCheck = report.checks.find((c) => c.name === 'provider auth');
    expect(providerCheck).toBeDefined();
    expect(providerCheck?.ok).toBe(true);
    expect(formatPreflightReport(report)).toContain('preflight: provider auth ok');
  });

  it('fails provider auth when reviewProvider is cursor but CURSOR_API_KEY is absent', async () => {
    const report = await runPreflight(githubDoctor({ reviewProvider: 'cursor' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    expect(report.ok).toBe(false);
    const providerCheck = report.checks.find((c) => c.name === 'provider auth');
    expect(providerCheck?.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain(
      'preflight: provider auth Provider "cursor" needs CURSOR_API_KEY in the environment. -> stop before claim',
    );
  });

  it('fails provider auth for doctor-prs with codex and llmProxy true when OpenAI key is absent', async () => {
    const report = await runPreflight(doctorPrs({ provider: 'codex', llmProxy: true }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(['ready for vanguard review', 'vanguard:reviewing', 'vanguard:reviewed']),
    });

    expect(report.ok).toBe(false);
    const providerCheck = report.checks.find((c) => c.name === 'provider auth');
    expect(providerCheck?.ok).toBe(false);
  });

  it('regression: no-provider doctor report contains no provider auth check', async () => {
    const report = await runPreflight(githubDoctor(), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });

    const providerCheck = report.checks.find((c) => c.name === 'provider auth');
    expect(providerCheck).toBeUndefined();
    expect(formatPreflightReport(report)).not.toContain('provider auth');
  });
});
