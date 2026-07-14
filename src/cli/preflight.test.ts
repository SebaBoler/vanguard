import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runPreflight, formatPreflightReport } from './preflight.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;
type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;
type WatchCommand = Extract<Command, { kind: 'watch' }>;

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

function makeRunner(labels: string[] = ['ready for spec', 'ready for agent', 'needs info', GITHUB_SPEC_CLAIMED_LABEL, GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL]): PreflightRunner {
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
      run: makeRunner(['ready for spec', 'ready for agent', 'needs info', GITHUB_SPEC_CLAIMED_LABEL, GITHUB_CLAIMED_LABEL]),
    });

    expect(report.ok).toBe(false);
    expect(formatPreflightReport(report)).toContain('preflight: github labels missing vanguard:needs-human-review -> stop before claim');
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
      'preflight: provider combo ok',
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
    expect(formatPreflightReport(report)).toContain(
      'preflight: provider auth Provider "codex" needs CODEX_API_KEY or OPENAI_API_KEY in the environment. -> stop before claim',
    );
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

describe('runPreflight gitlab source', () => {
  const baseCmd = {
    kind: 'doctor' as const,
    source: 'gitlab' as const,
    project: 'g/p',
    repoPath: '/repo',
    label: 'vanguard',
  };

  it('checks glab auth when GITLAB_TOKEN is absent', async () => {
    let glabAuthCalled = false;
    const run: PreflightRunner = async (cmd, args) => {
      if (cmd === 'glab' && args[0] === 'auth') { glabAuthCalled = true; return { stdout: 'ok' }; }
      if (cmd === 'git') return { stdout: 'https://gitlab.com/g/p.git' };
      if (cmd === 'docker') return { stdout: '{}' };
      if (cmd === 'glab' && args[0] === 'label') return { stdout: '[]' };
      return { stdout: '' };
    };
    await runPreflight(baseCmd, { env: {}, nodeVersion: '24.0.0', run });
    expect(glabAuthCalled).toBe(true);
  });

  it('skips glab auth check when GITLAB_TOKEN is set', async () => {
    let glabAuthCalled = false;
    const run: PreflightRunner = async (cmd, args) => {
      if (cmd === 'glab' && args[0] === 'auth') { glabAuthCalled = true; return { stdout: '' }; }
      if (cmd === 'git') return { stdout: 'https://gitlab.com/g/p.git' };
      if (cmd === 'docker') return { stdout: '{}' };
      if (cmd === 'glab' && args[0] === 'label') return { stdout: '[]' };
      return { stdout: '' };
    };
    await runPreflight(baseCmd, { env: { GITLAB_TOKEN: 'token', ANTHROPIC_API_KEY: 'key' }, nodeVersion: '24.0.0', run });
    expect(glabAuthCalled).toBe(false);
  });
});

function githubWatch(overrides: Partial<WatchCommand> = {}): WatchCommand {
  return {
    kind: 'watch',
    source: 'github',
    repoPath: '/repo',
    repoSlug: 'owner/repo',
    label: 'vanguard',
    concurrency: 1,
    intervalMs: 60000,
    once: false,
    egress: false,
    ...overrides,
  };
}

describe('runPreflight provider combo check', () => {
  it('fails provider combo when claude implements and zai reviews (shared anthropic transport)', async () => {
    const report = await runPreflight(
      githubWatch({ provider: 'claude', reviewProvider: 'zai' }),
      {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', ZAI_API_KEY: 'z-key' },
        nodeVersion: '24.11.1',
        run: makeRunner(),
      },
    );

    expect(report.ok).toBe(false);
    const comboCheck = report.checks.find((c) => c.name === 'provider combo');
    expect(comboCheck).toBeDefined();
    expect(comboCheck?.ok).toBe(false);
    expect(comboCheck?.reason).toMatch(/cannot mix "claude" and "zai"/);
  });

  it('passes provider combo when codex implements and zai reviews (different transports)', async () => {
    const report = await runPreflight(
      githubWatch({ provider: 'codex', reviewProvider: 'zai' }),
      {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' },
        nodeVersion: '24.11.1',
        run: makeRunner(),
      },
    );

    const comboCheck = report.checks.find((c) => c.name === 'provider combo');
    expect(comboCheck).toBeDefined();
    expect(comboCheck?.ok).toBe(true);
  });

  it('fails provider combo when zai is reviewer-only under --llm-proxy', async () => {
    const report = await runPreflight(
      githubWatch({ provider: 'codex', reviewProvider: 'zai', llmProxy: true }),
      {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_API_KEY: 'c-key', ZAI_API_KEY: 'z-key' },
        nodeVersion: '24.11.1',
        run: makeRunner(),
      },
    );

    expect(report.ok).toBe(false);
    const comboCheck = report.checks.find((c) => c.name === 'provider combo');
    expect(comboCheck).toBeDefined();
    expect(comboCheck?.ok).toBe(false);
    expect(comboCheck?.reason).toMatch(/needs "zai" as the implementer/);
  });

  it('passes codex auth on a well-formed CODEX_AUTH_JSON when codex is selected', async () => {
    const report = await runPreflight(githubDoctor({ reviewProvider: 'codex' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt' } }) },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(report.checks.find((c) => c.name === 'codex auth')?.ok).toBe(true);
  });

  it('fails codex auth on a CODEX_AUTH_JSON missing tokens.refresh_token', async () => {
    const report = await runPreflight(githubDoctor({ reviewProvider: 'codex' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_AUTH_JSON: '{"auth_mode":"chatgpt"}' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'codex auth')?.ok).toBe(false);
  });

  it('skips codex auth when CODEX_AUTH_JSON is unset (API-key mode)', async () => {
    const report = await runPreflight(githubDoctor({ reviewProvider: 'codex' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token', CODEX_API_KEY: 'c-key' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(report.checks.find((c) => c.name === 'codex auth')).toBeUndefined();
  });

  it('fails pr-create setting when disabled, passes when enabled, skips when unreadable', async () => {
    const withApi = (canApprove: boolean): PreflightRunner => async (cmd, args, opts) =>
      cmd === 'gh' && args[0] === 'api'
        ? { stdout: JSON.stringify({ can_approve_pull_request_reviews: canApprove }) }
        : makeRunner()(cmd, args, opts);
    const env = { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' };

    const disabled = await runPreflight(githubDoctor(), { env, nodeVersion: '24.11.1', run: withApi(false) });
    expect(disabled.ok).toBe(false);
    expect(disabled.checks.find((c) => c.name === 'pr-create setting')?.ok).toBe(false);

    const enabled = await runPreflight(githubDoctor(), { env, nodeVersion: '24.11.1', run: withApi(true) });
    expect(enabled.checks.find((c) => c.name === 'pr-create setting')?.ok).toBe(true);

    // makeRunner throws on `gh api` -> runOk catches -> unreadable -> best-effort skip (no check pushed)
    const unreadable = await runPreflight(githubDoctor(), { env, nodeVersion: '24.11.1', run: makeRunner() });
    expect(unreadable.checks.find((c) => c.name === 'pr-create setting')).toBeUndefined();
  });
});


describe('runPreflight with S6 custom providers', () => {
  async function repoWithCustoms(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'vg-preflight-'));
    await mkdir(join(repo, '.vanguard'), { recursive: true });
    await writeFile(
      join(repo, '.vanguard', 'app.json'),
      JSON.stringify({ customProviders: [{ name: 'my-proxy', baseUrl: 'https://llm.example.com/api', keyEnv: 'MY_PROXY_API_KEY' }] }),
    );
    return repo;
  }

  it('llm auth follows the custom keyEnv, not the Anthropic credential', async () => {
    const repoPath = await repoWithCustoms();
    const withKey = await runPreflight(githubDoctor({ repoPath, provider: 'my-proxy' }), {
      env: { GH_TOKEN: 'gh', MY_PROXY_API_KEY: 'sk' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(withKey.checks.find((c) => c.name === 'llm auth')).toMatchObject({ ok: true });

    // an Anthropic token does NOT satisfy a custom's key requirement
    const wrongKey = await runPreflight(githubDoctor({ repoPath, provider: 'my-proxy' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(wrongKey.checks.find((c) => c.name === 'llm auth')).toMatchObject({ ok: false });
  });

  it('generalization fixes the stale zai literal: openrouter llm auth honors OPENROUTER_API_KEY', async () => {
    const report = await runPreflight(githubDoctor({ provider: 'openrouter' }), {
      env: { GH_TOKEN: 'gh', OPENROUTER_API_KEY: 'or-key' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(report.checks.find((c) => c.name === 'llm auth')).toMatchObject({ ok: true });
  });

  it('provider combo reports the direct-only failure for a custom under --llm-proxy', async () => {
    const repoPath = await repoWithCustoms();
    const report = await runPreflight(githubDoctor({ repoPath, provider: 'my-proxy', llmProxy: true }), {
      env: { GH_TOKEN: 'gh', MY_PROXY_API_KEY: 'sk' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    const combo = report.checks.find((c) => c.name === 'provider combo');
    expect(combo).toMatchObject({ ok: false });
    expect(combo?.reason).toMatch(/direct-mode only/);
  });

  it('an unknown provider name fails checks instead of crashing preflight', async () => {
    const repoPath = await repoWithCustoms();
    const report = await runPreflight(githubDoctor({ repoPath, provider: 'bogus' }), {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
      nodeVersion: '24.11.1',
      run: makeRunner(),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'provider combo')).toMatchObject({ ok: false });
  });
});
