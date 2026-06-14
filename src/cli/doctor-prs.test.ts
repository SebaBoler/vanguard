import { describe, it, expect } from 'vitest';
import { doctorPrsCommand } from './doctor-prs.js';
import type { Command } from './args.js';
import type { PreflightRunner } from './preflight.js';

type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;

const cmd: DoctorPrsCommand = {
  kind: 'doctor-prs',
  repoPath: '/repo',
  repoSlug: 'owner/repo',
  label: 'ready for vanguard review',
  reviewingLabel: 'vanguard:reviewing',
  reviewedLabel: 'vanguard:reviewed',
};

const runner: PreflightRunner = async (name, args) => {
  if (name === 'git' && args[0] === 'rev-parse') return { stdout: '/repo' };
  if (name === 'git' && args[0] === 'remote') return { stdout: 'https://github.com/owner/repo.git' };
  if (name === 'docker') return { stdout: '' };
  if (name === 'gh' && args[0] === 'label') {
    return {
      stdout: JSON.stringify(['ready for vanguard review', 'vanguard:reviewing', 'vanguard:reviewed'].map((label) => ({ name: label }))),
    };
  }
  return { stdout: '' };
};

describe('doctorPrsCommand', () => {
  it('prints preflight lines when PR watch checks pass', async () => {
    const logs: string[] = [];

    await doctorPrsCommand(cmd, {
      env: { GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      nodeVersion: '24.11.1',
      run: runner,
      log: (line) => logs.push(line),
    });

    expect(logs).toContain('preflight: llm auth ok');
    expect(logs).toContain('preflight: github labels ok');
  });

  it('throws after printing failures when a PR watch check fails', async () => {
    const logs: string[] = [];

    await expect(
      doctorPrsCommand(cmd, {
        env: { GH_TOKEN: 'gh' },
        nodeVersion: '24.11.1',
        run: runner,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow('preflight failed');

    expect(logs).toContain('preflight: llm auth missing -> stop before claim');
  });
});
