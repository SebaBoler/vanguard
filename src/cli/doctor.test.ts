import { describe, it, expect } from 'vitest';
import { doctorCommand } from './doctor.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

const cmd: DoctorCommand = {
  kind: 'doctor',
  source: 'github',
  repoPath: '/repo',
  repoSlug: 'owner/repo',
  specLabel: 'ready for spec',
  agentLabel: 'ready for agent',
  needsInfoLabel: 'needs info',
};

const runner: PreflightRunner = async (name, args) => {
  if (name === 'git' && args[0] === 'rev-parse') return { stdout: '/repo' };
  if (name === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/owner/repo.git' };
  if (name === 'docker') return { stdout: '' };
  if (name === 'gh' && args[0] === 'label') {
    return {
      stdout: JSON.stringify(
        ['ready for spec', 'ready for agent', 'needs info', GITHUB_SPEC_CLAIMED_LABEL, GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL].map((label) => ({ name: label })),
      ),
    };
  }
  return { stdout: '' };
};

describe('doctorCommand', () => {
  it('prints preflight lines when checks pass', async () => {
    const logs: string[] = [];

    await doctorCommand(cmd, {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: runner,
      log: (line) => logs.push(line),
    });

    expect(logs).toContain('preflight: llm auth ok');
    expect(logs).toContain('preflight: github labels ok');
  });

  it('throws after printing failures when a check fails', async () => {
    const logs: string[] = [];

    await expect(
      doctorCommand(cmd, {
        env: { GH_TOKEN: 'gh' },
        nodeVersion: '24.11.1',
        run: runner,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('preflight failed');

    expect(logs).toContain('preflight: llm auth missing -> stop before claim');
  });

  it('surfaces provider auth failure line when codex key is missing', async () => {
    const logs: string[] = [];
    const codexCmd: DoctorCommand = { ...cmd, provider: 'codex' };

    await expect(
      doctorCommand(codexCmd, {
        env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
        nodeVersion: '24.11.1',
        run: runner,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('preflight failed');

    expect(logs).toContain(
      'preflight: provider auth Provider "codex" needs CODEX_API_KEY or OPENAI_API_KEY in the environment. -> stop before claim',
    );
  });
});
