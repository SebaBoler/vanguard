import { describe, it, expect, assert } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli', () => {
  it('defaults gc to cwd, 6h, no remote, not dry-run', () => {
    expect(parseCli(['gc'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/work',
      maxAgeMs: 6 * 60 * 60 * 1000,
      dryRun: false,
      abandoned: false,
    });
  });

  it('parses gc options', () => {
    expect(
      parseCli(['gc', '--repo', '/r', '--max-age-hours', '2', '--remote', 'o/r', '--dry-run', '--abandoned'], '/work'),
    ).toEqual({
      kind: 'gc',
      repoPath: '/r',
      maxAgeMs: 2 * 60 * 60 * 1000,
      remoteRepo: 'o/r',
      dryRun: true,
      abandoned: true,
    });
  });

  it('falls back to the default age on a non-numeric value', () => {
    const cmd = parseCli(['gc', '--max-age-hours', 'soon'], '/work');
    expect(cmd.kind === 'gc' && cmd.maxAgeMs).toBe(6 * 60 * 60 * 1000);
  });

  it('returns help for no command, an unknown command, or --help', () => {
    expect(parseCli([], '/work').kind).toBe('help');
    expect(parseCli(['frobnicate'], '/work').kind).toBe('help');
    expect(parseCli(['gc', '--help'], '/work').kind).toBe('help');
    expect(parseCli(['gc', '--bogus-flag'], '/work').kind).toBe('help');
  });

  it('parses a linear run with parent fan-out', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--parent', '--skills', '/s', '--concurrency', '3'], '/work')).toEqual({
      kind: 'run',
      source: 'linear',
      id: 'TES-1',
      parent: true,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 3,
      skillsDir: '/s',
    });
  });

  it('parses a github run with an explicit repo slug and defaults', () => {
    expect(parseCli(['run', '--github', 'o/r#5', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'run',
      source: 'github',
      id: 'o/r#5',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
    });
  });

  it('parses a project run with a label filter', () => {
    expect(parseCli(['run', '--project', '7', '--github-repo', 'o/r', '--label', 'todo'], '/work')).toEqual({
      kind: 'run',
      source: 'project',
      id: '7',
      parent: false,
      gcBefore: false,
      egress: false,
      repoPath: '/work',
      concurrency: 2,
      repoSlug: 'o/r',
      label: 'todo',
    });
  });

  it('parses --gc-before', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--gc-before'], '/work');
    expect(cmd.kind === 'run' && cmd.gcBefore).toBe(true);
  });

  it('parses --reuse', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--reuse'], '/work');
    expect(cmd.kind === 'run' && cmd.reuse).toBe(true);
  });

  it('omits reuse when --reuse is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'reuse' in cmd).toBe(false);
  });

  it('parses --llm-proxy into llmProxy', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--llm-proxy'], '/work');
    expect(cmd.kind === 'run' && cmd.llmProxy).toBe(true);
  });

  it('omits llmProxy when --llm-proxy is not passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'llmProxy' in cmd).toBe(false);
  });

  it('parses --provider and --review-provider (cross-provider review)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'codex'], '/work');
    expect(cmd.kind === 'run' && cmd.provider).toBe('claude');
    expect(cmd.kind === 'run' && cmd.reviewProvider).toBe('codex');
  });

  it('parses provider flags on watch too', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider', 'codex'], '/work');
    expect(cmd.kind === 'watch' && cmd.provider).toBe('codex');
  });

  it('omits provider fields when the flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'provider' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewProvider' in cmd).toBe(false);
  });

  it('parses --fork into forkN (>=2)', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--fork', '3'], '/work');
    expect(cmd.kind === 'run' && cmd.forkN).toBe(3);
  });

  it('ignores --fork below 2 or non-numeric', () => {
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', '1'], '/work')).toBe(false);
    expect('forkN' in parseCli(['run', '--linear', 'TES-1', '--fork', 'x'], '/work')).toBe(false);
  });

  it('returns an error for an unknown provider name', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'gpt'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown provider "gpt"'),
    });
    expect(parseCli(['run', '--linear', 'TES-1', '--review-provider', 'bard'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unknown review-provider "bard"'),
    });
  });

  it('returns an error when implement and review providers share a transport', () => {
    expect(
      parseCli(['run', '--linear', 'TES-1', '--provider', 'claude', '--review-provider', 'zai'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('transport'),
    });
  });

  it('parses --provider-model and --review-model on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--provider-model', 'opus', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'run' && cmd.providerModel).toBe('opus');
    expect(cmd.kind === 'run' && cmd.reviewModel).toBe('haiku');
  });

  it('parses --no-simplify on run and watch (absent => undefined)', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work').kind === 'run' && parseCli(['run', '--linear', 'TES-1', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect(parseCli(['watch', '--label', 'vanguard', '--no-simplify'], '/work')).toMatchObject({ noSimplify: true });
    expect('noSimplify' in parseCli(['run', '--linear', 'TES-1'], '/work')).toBe(false);
  });

  it('parses --max-turns and --max-repair-iterations on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--max-turns', '80'], '/work');
    expect(cmd.kind === 'run' && cmd.maxTurns).toBe(80);
    const cmd2 = parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '5'], '/work');
    expect(cmd2.kind === 'run' && cmd2.maxRepairIterations).toBe(5);
  });

  it('parses --max-turns and --max-repair-iterations on watch', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--github-repo', 'o/r', '--max-turns', '80', '--max-repair-iterations', '5'],
      '/work',
    );
    expect(cmd.kind === 'watch' && cmd.maxTurns).toBe(80);
    expect(cmd.kind === 'watch' && cmd.maxRepairIterations).toBe(5);
  });

  it('rejects --max-turns 0, negative, or non-numeric (no override set)', () => {
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '0'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', '-3'], '/work')).toBe(false);
    expect('maxTurns' in parseCli(['run', '--linear', 'TES-1', '--max-turns', 'x'], '/work')).toBe(false);
  });

  it('rejects --max-repair-iterations 0, negative, or non-numeric (no override set)', () => {
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '0'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', '-3'], '/work')).toBe(false);
    expect('maxRepairIterations' in parseCli(['run', '--linear', 'TES-1', '--max-repair-iterations', 'x'], '/work')).toBe(false);
  });

  it('omits maxTurns and maxRepairIterations when neither flag is passed', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect('maxTurns' in cmd).toBe(false);
    expect('maxRepairIterations' in cmd).toBe(false);
  });

  it('parses review-pr with a GitHub PR URL', () => {
    expect(
      parseCli(['review-pr', 'https://github.com/o/r/pull/12', '--repo', '/work', '--provider', 'codex', '--review-model', 'gpt-5'], '/cwd'),
    ).toEqual({
      kind: 'review-pr',
      prRef: 'https://github.com/o/r/pull/12',
      repoPath: '/work',
      provider: 'codex',
      reviewModel: 'gpt-5',
      egress: false,
    });
  });

  it('parses review-pr with --github-pr and --github-repo', () => {
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r', '--llm-proxy'], '/work')).toEqual({
      kind: 'review-pr',
      prRef: '12',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
      llmProxy: true,
    });
  });

  it('parses watch-prs with label routing defaults', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'ready for vanguard review',
          '--provider', 'codex',
          '--review-model', 'gpt-5',
          '--interval', '15',
          '--concurrency', '1',
          '--once',
          '--egress',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
      concurrency: 1,
      intervalMs: 15000,
      once: true,
      egress: true,
      provider: 'codex',
      reviewModel: 'gpt-5',
    });
  });

  it('parses custom watch-prs state labels', () => {
    expect(
      parseCli(
        [
          'watch-prs',
          '--github-repo', 'o/r',
          '--label', 'needs review',
          '--reviewing-label', 'robot:reviewing',
          '--reviewed-label', 'robot:reviewed',
        ],
        '/work',
      ),
    ).toEqual({
      kind: 'watch-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'needs review',
      reviewingLabel: 'robot:reviewing',
      reviewedLabel: 'robot:reviewed',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses watch-prs with an author filter', () => {
    const cmd = parseCli(
      [
        'watch-prs',
        '--github-repo', 'o/r',
        '--label', 'ready for vanguard review',
        '--author', 'SebaBoler',
      ],
      '/work',
    );
    expect(cmd).toMatchObject({ kind: 'watch-prs', author: 'SebaBoler' });
  });

  it('omits the author filter when --author is not given', () => {
    const cmd = parseCli(['watch-prs', '--github-repo', 'o/r', '--label', 'x'], '/work');
    expect(cmd.kind).toBe('watch-prs');
    expect((cmd as Extract<typeof cmd, { kind: 'watch-prs' }>).author).toBeUndefined();
  });

  it('requires watch-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['watch-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['watch-prs', '--label', 'ready for vanguard review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses doctor-prs with PR review label defaults', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for vanguard review'], '/work')).toEqual({
      kind: 'doctor-prs',
      repoSlug: 'o/r',
      repoPath: '/work',
      label: 'ready for vanguard review',
      reviewingLabel: 'vanguard:reviewing',
      reviewedLabel: 'vanguard:reviewed',
    });
  });

  it('requires doctor-prs to have an explicit repo and trigger label', () => {
    expect(parseCli(['doctor-prs', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['doctor-prs', '--label', 'ready for vanguard review'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses doctor with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor', '--source', 'github', '--github-repo', 'o/r', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor');
    if (cmd.kind === 'doctor') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });

  it('parses doctor-prs with --provider and --llm-proxy', () => {
    const cmd = parseCli(
      ['doctor-prs', '--github-repo', 'o/r', '--label', 'ready for vanguard review', '--provider', 'codex', '--llm-proxy'],
      '/work',
    );
    expect(cmd.kind).toBe('doctor-prs');
    if (cmd.kind === 'doctor-prs') {
      expect(cmd.provider).toBe('codex');
      expect(cmd.llmProxy).toBe(true);
    }
  });

  it('does not set llmProxy or provider on doctor without those flags (regression)', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('llmProxy' in cmd).toBe(false);
    expect((cmd as Extract<typeof cmd, { kind: 'doctor' }>).provider).toBeUndefined();
  });

  it('omits providerModel and reviewModel when flags are absent', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'providerModel' in cmd).toBe(false);
    expect(cmd.kind === 'run' && 'reviewModel' in cmd).toBe(false);
  });

  it('parses --provider-model and --review-model on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--provider-model', 'sonnet', '--review-model', 'haiku'], '/work');
    expect(cmd.kind === 'watch' && cmd.providerModel).toBe('sonnet');
    expect(cmd.kind === 'watch' && cmd.reviewModel).toBe('haiku');
  });

  it('parses a linear watch with defaults and a required label', () => {
    expect(parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
    });
  });

  it('parses a github watch with markers and interval', () => {
    expect(
      parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--claimed-state', 'wip', '--interval', '30', '--once'], '/work'),
    ).toEqual({
      kind: 'watch',
      source: 'github',
      label: 'vanguard',
      claimedState: 'wip',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 30000,
      once: true,
      egress: false,
    });
  });

  it('infers github source when --github-repo is supplied on watch', () => {
    const cmd = parseCli(['watch', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.source).toBe('github');
      expect(cmd.repoSlug).toBe('o/r');
    }
  });

  it('uses safe github loop-v1 defaults for a repo-only watch command', () => {
    expect(parseCli(['watch', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses safe github loop-v1 defaults for a repo-only doctor command', () => {
    expect(parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r'], '/work')).toEqual({
      kind: 'doctor',
      source: 'github',
      repoPath: '/work',
      repoSlug: 'o/r',
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
    });
  });

  it('uses loop-v1 defaults with an explicit github ownership label', () => {
    const cmd = parseCli(['watch', '--source', 'github', '--loop-v1', '--label', 'ai', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('ai');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('uses safe linear loop-v1 defaults when --loop-v1 is supplied', () => {
    expect(parseCli(['watch', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('uses safe linear loop-v1 defaults for doctor when --loop-v1 is supplied', () => {
    expect(parseCli(['doctor', '--loop-v1', '--team', 'TES'], '/work')).toEqual({
      kind: 'doctor',
      source: 'linear',
      label: 'vanguard',
      team: 'TES',
      repoPath: '/work',
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
    });
  });

  it('watch requires --label', () => {
    expect(parseCli(['watch'], '/work')).toMatchObject({
      kind: 'error',
      message: 'watch --source linear requires --label <name>.',
    });
  });

  it('parses stats with defaults and flags', () => {
    expect(parseCli(['stats'], '/work')).toEqual({ kind: 'stats', repoPath: '/work', json: false });
    expect(parseCli(['stats', '--repo', '/r', '--json'], '/work')).toEqual({ kind: 'stats', repoPath: '/r', json: true });
  });

  it('parses memory with defaults (no limit field)', () => {
    expect(parseCli(['memory'], '/work')).toEqual({ kind: 'memory', repoPath: '/work', json: false });
  });

  it('parses memory with --repo, --limit, and --json', () => {
    expect(parseCli(['memory', '--repo', '/r', '--limit', '5', '--json'], '/work')).toEqual({
      kind: 'memory',
      repoPath: '/r',
      limit: 5,
      json: true,
    });
  });

  it('falls back to no limit field on invalid --limit for memory', () => {
    const cmd = parseCli(['memory', '--limit', 'soon'], '/work');
    expect(cmd.kind === 'memory' && cmd.limit === undefined).toBe(true);
  });

  it('returns an error when run has no source or more than one source', () => {
    expect(parseCli(['run'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--linear', 'A', '--github', 'B'], '/work')).toMatchObject({ kind: 'error' });
    expect(parseCli(['run', '--github', 'A', '--project', '3'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('returns an error when run --parent is used without --linear', () => {
    expect(parseCli(['run', '--github', 'o/r#1', '--parent'], '/work')).toMatchObject({
      kind: 'error',
      message: '--parent is only supported with --linear.',
    });
  });

  it('returns an error when run --project is not a positive integer', () => {
    expect(parseCli(['run', '--project', 'x'], '/work')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('--project expects a board number'),
    });
    expect(parseCli(['run', '--project', '0'], '/work')).toMatchObject({ kind: 'error' });
  });

  it('parses --verify into verifyCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--verify', 'pnpm test'], '/work');
    expect(cmd.kind === 'run' && cmd.verifyCmd).toBe('pnpm test');
  });

  it('omits verifyCmd when --verify is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --verify into verifyCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--verify', 'npm test'], '/work');
    expect(cmd.kind === 'watch' && cmd.verifyCmd).toBe('npm test');
  });

  it('omits verifyCmd when --verify is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'verifyCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind === 'run' && cmd.visualProofCmd).toBe('pnpm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on run', () => {
    const cmd = parseCli(['run', '--linear', 'TES-1'], '/work');
    expect(cmd.kind === 'run' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('parses --visual-proof into visualProofCmd on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--visual-proof', 'npm shot'], '/work');
    expect(cmd.kind === 'watch' && cmd.visualProofCmd).toBe('npm shot');
  });

  it('omits visualProofCmd when --visual-proof is not passed on watch', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard'], '/work');
    expect(cmd.kind === 'watch' && 'visualProofCmd' in cmd).toBe(false);
  });

  it('does not leak visualProofCmd onto doctor', () => {
    const cmd = parseCli(['doctor', '--source', 'github', '--github-repo', 'o/r', '--visual-proof', 'pnpm shot'], '/work');
    expect(cmd.kind).toBe('doctor');
    expect('visualProofCmd' in cmd).toBe(false);
  });

  it('parses --conformance flags on run', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(cmd.kind === 'run' && cmd.conformance).toBe(true);
    expect(cmd.kind === 'run' && cmd.conformanceModel).toBe('opus');
  });

  it('parses --conformance flags on watch but not doctor', () => {
    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--conformance', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.conformance).toBe(true);
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');

    const doctor = parseCli(['doctor', '--source', 'github', '--label', 'vanguard', '--conformance'], '/work');
    expect(doctor.kind).toBe('doctor');
    expect('conformance' in doctor).toBe(false);
    expect('conformanceModel' in doctor).toBe(false);
  });

  it('parses --conformance flags for gitlab runs and watches', () => {
    const run = parseCli(['run', '--gitlab', '7', '--conformance'], '/work');
    expect(run.kind === 'run' && run.source).toBe('gitlab');
    expect(run.kind === 'run' && run.conformance).toBe(true);

    const watch = parseCli(['watch', '--source', 'gitlab', '--label', 'vanguard', '--conformance-model', 'opus'], '/work');
    expect(watch.kind === 'watch' && watch.source).toBe('gitlab');
    expect(watch.kind === 'watch' && watch.conformanceModel).toBe('opus');
  });

  it('parses --commit-author "Name <email>" on run and watch', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <spietrza@gmail.com>'], '/work');
    expect(run.kind === 'run' && run.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 'spietrza@gmail.com' });

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--commit-author', 'A B <a@b.co>'], '/work');
    expect(watch.kind === 'watch' && watch.commitAuthor).toEqual({ name: 'A B', email: 'a@b.co' });
  });

  it('rejects a malformed --commit-author', () => {
    const cmd = parseCli(['run', '--github', 'o/r#1', '--commit-author', 'no-email-here'], '/work');
    expect(cmd.kind).toBe('error');
    expect(cmd.kind === 'error' && cmd.message).toMatch(/Invalid --commit-author/);
  });

  it('parses --plan on run and watch (off by default)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--plan'], '/work');
    expect(run.kind === 'run' && run.plan).toBe(true);

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--plan'], '/work');
    expect(watch.kind === 'watch' && watch.plan).toBe(true);

    const noPlan = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noPlan.kind === 'run' && 'plan' in noPlan).toBe(false);
  });

  it('parses --base on run and watch (defaults to undefined)', () => {
    const run = parseCli(['run', '--github', 'o/r#1', '--base', 'dev'], '/work');
    expect(run.kind === 'run' && run.baseBranch).toBe('dev');

    const watch = parseCli(['watch', '--source', 'github', '--label', 'vanguard', '--base', 'dev'], '/work');
    expect(watch.kind === 'watch' && watch.baseBranch).toBe('dev');

    const noBase = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(noBase.kind === 'run' && 'baseBranch' in noBase).toBe(false);
  });

  it('parses review-pr --out (write-to-file, no PR comment)', () => {
    const cmd = parseCli(['review-pr', 'o/r#12', '--review-model', 'claude-fable-5', '--out', '.vanguard/reviews/12.md'], '/work');
    expect(cmd.kind).toBe('review-pr');
    expect(cmd.kind === 'review-pr' && cmd.out).toBe('.vanguard/reviews/12.md');
    expect(cmd.kind === 'review-pr' && cmd.reviewModel).toBe('claude-fable-5');
    const without = parseCli(['review-pr', 'o/r#12'], '/work');
    expect(without.kind === 'review-pr' && 'out' in without).toBe(false);
  });

  it('accepts the PR ref via positional, --github-pr, or --github (parity with spec/run)', () => {
    expect(parseCli(['review-pr', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr', '--github-pr', '12', '--github-repo', 'o/r'], '/work')).toMatchObject({ kind: 'review-pr', prRef: '12' });
    expect(parseCli(['review-pr', '--github', 'o/r#12'], '/work')).toMatchObject({ kind: 'review-pr', prRef: 'o/r#12' });
    expect(parseCli(['review-pr'], '/work').kind).toBe('error');
  });

  it('parses revise-pr with --commit-author (white-label) and the --github alias', () => {
    const cmd = parseCli(
      ['revise-pr', '--github', 'o/r#12', '--review-model', 'claude-fable-5', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('revise-pr');
    expect(cmd.kind === 'revise-pr' && cmd.prRef).toBe('o/r#12');
    expect(cmd.kind === 'revise-pr' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
    const without = parseCli(['revise-pr', 'o/r#12'], '/work');
    expect(without.kind === 'revise-pr' && 'commitAuthor' in without).toBe(false);
  });

  it('parses --commit-author on research (white-label toggle)', () => {
    const cmd = parseCli(['research', 'o/r#1', '--commit-author', 'Sebastian Pietrzak <s@p.co>'], '/work');
    expect(cmd.kind).toBe('research');
    expect(cmd.kind === 'research' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });

  it('parses spec with --spec-model and --commit-author (white-label toggle)', () => {
    const cmd = parseCli(
      ['spec', 'o/r#1', '--spec-model', 'claude-fable-5', '--commit-author', 'Sebastian Pietrzak <s@p.co>'],
      '/work',
    );
    expect(cmd.kind).toBe('spec');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('o/r#1');
    expect(cmd.kind === 'spec' && cmd.specModel).toBe('claude-fable-5');
    expect(cmd.kind === 'spec' && cmd.commitAuthor).toEqual({ name: 'Sebastian Pietrzak', email: 's@p.co' });
  });

  it('parses spec with a bare number and --github-repo, and returns help without a ref', () => {
    const cmd = parseCli(['spec', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'spec' && cmd.repoSlug).toBe('o/r');
    expect(cmd.kind === 'spec' && cmd.issueRef).toBe('7');
    expect(parseCli(['spec'], '/work').kind).toBe('help');
  });

  it('parses spec --out and run --spec-file (local-file spec flow)', () => {
    const spec = parseCli(['spec', 'o/r#1', '--out', '.vanguard/specs/1.md'], '/work');
    expect(spec.kind === 'spec' && spec.out).toBe('.vanguard/specs/1.md');

    const run = parseCli(['run', '--github', 'o/r#1', '--spec-file', '.vanguard/specs/1.md'], '/work');
    expect(run.kind === 'run' && run.specFile).toBe('.vanguard/specs/1.md');
    const without = parseCli(['run', '--github', 'o/r#1'], '/work');
    expect(without.kind === 'run' && 'specFile' in without).toBe(false);

    // One spec file cannot describe N fan-out tasks.
    expect(parseCli(['run', '--project', '7', '--spec-file', 's.md'], '/work').kind).toBe('error');
    expect(parseCli(['run', '--linear', 'ABC-1', '--parent', '--spec-file', 's.md'], '/work').kind).toBe('error');
  });

  // --- Loop v1 flag tests ---

  it('parses a github loop-v1 watch with spec/agent/needs-info labels and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-model', 'haiku',
        '--github-repo', 'o/r',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'github',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specLabel: 'ready for spec',
      agentLabel: 'ready for agent',
      needsInfoLabel: 'needs info',
      specModel: 'haiku',
      repoSlug: 'o/r',
    });
  });

  it('parses a linear loop-v1 watch with spec-state/spec-state-name/needs-info-state and spec-model', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-model', 'haiku',
        '--trigger-state', 'unstarted',
      ],
      '/work',
    );
    expect(cmd).toEqual({
      kind: 'watch',
      source: 'linear',
      label: 'vanguard',
      repoPath: '/work',
      concurrency: 2,
      intervalMs: 60000,
      once: false,
      egress: false,
      specState: 'triage',
      specStateName: 'Spec',
      needsInfoState: 'Needs Info',
      specModel: 'haiku',
      triggerState: 'unstarted',
    });
  });

  it('omits all loop-v1 fields when their flags are absent (existing watch parse unchanged)', () => {
    const cmd = parseCli(['watch', '--label', 'vanguard', '--team', 'TES'], '/work');
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specLabel' in cmd).toBe(false);
      expect('agentLabel' in cmd).toBe(false);
      expect('needsInfoLabel' in cmd).toBe(false);
      expect('specState' in cmd).toBe(false);
      expect('specStateName' in cmd).toBe(false);
      expect('agentState' in cmd).toBe(false);
      expect('needsInfoState' in cmd).toBe(false);
      expect('specModel' in cmd).toBe(false);
    }
  });

  it('parses --agent-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--agent-state', 'Ready',
      ],
      '/work',
    );
    if (cmd.kind !== 'watch') throw new Error('expected watch');
    expect(cmd.agentState).toBe('Ready');
  });

  it('returns an error when a github loop-v1 flag is supplied on --source linear', () => {
    expect(
      parseCli(['watch', '--source', 'linear', '--spec-label', 'ready for spec'], '/work'),
    ).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('GitHub loop-v1 flags'),
    });
  });

  it('defaults github loop-v1 agent label when --agent-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--needs-info-label', 'needs info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('defaults github loop-v1 needs-info label when --needs-info-label is missing', () => {
    const cmd = parseCli(
      ['watch', '--source', 'github', '--spec-label', 'ready for spec', '--agent-label', 'ready for agent'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
      expect(cmd.needsInfoLabel).toBe('needs info');
    }
  });

  it('defaults linear loop-v1 spec state name when --spec-state-name is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specStateName).toBe('Spec');
    }
  });

  it('defaults linear loop-v1 needs-info state when --needs-info-state is missing', () => {
    const cmd = parseCli(
      ['watch', '--label', 'vanguard', '--spec-state', 'triage', '--spec-state-name', 'Spec'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.needsInfoState).toBe('Needs Info');
    }
  });

  it('defaults linear loop-v1 ownership label when --label is missing', () => {
    const cmd = parseCli(
      ['watch', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
    }
  });

  it('returns an error when loop-v1 is attempted on project source', () => {
    expect(
      parseCli(
        ['watch', '--source', 'project', '--project', '7', '--spec-state', 'triage', '--spec-state-name', 'Spec', '--needs-info-state', 'Needs Info'],
        '/work',
      ),
    ).toMatchObject({
      kind: 'error',
      message: 'loop-v1 is not supported with --source project.',
    });
  });

  // --- FIX 1: --label as ownership filter for github loop-v1 ---

  it('parses --label into github loop-v1 when supplied alongside spec/agent/needs-info flags', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--label', 'vanguard',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.label).toBe('vanguard');
      expect(cmd.specLabel).toBe('ready for spec');
      expect(cmd.agentLabel).toBe('ready for agent');
    }
  });

  it('omits github loop-v1 ownership label when --label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('label' in cmd).toBe(false);
    }
  });

  // --- FIX 2: --spec-claimed-state and --spec-claimed-label flags ---

  it('parses --spec-claimed-state on linear loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
        '--spec-claimed-state', 'Analyzing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedState).toBe('Analyzing');
    }
  });

  it('omits specClaimedState when --spec-claimed-state is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--label', 'vanguard',
        '--spec-state', 'triage',
        '--spec-state-name', 'Spec',
        '--needs-info-state', 'Needs Info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedState' in cmd).toBe(false);
    }
  });

  it('parses --spec-claimed-label on github loop-v1', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
        '--spec-claimed-label', 'wip:speccing',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect(cmd.specClaimedLabel).toBe('wip:speccing');
    }
  });

  it('omits specClaimedLabel when --spec-claimed-label is absent', () => {
    const cmd = parseCli(
      [
        'watch',
        '--source', 'github',
        '--spec-label', 'ready for spec',
        '--agent-label', 'ready for agent',
        '--needs-info-label', 'needs info',
      ],
      '/work',
    );
    expect(cmd.kind).toBe('watch');
    if (cmd.kind === 'watch') {
      expect('specClaimedLabel' in cmd).toBe(false);
    }
  });
});

describe('parseCli revise-pr', () => {
  it('parses a bare PR number with --github-repo', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd).toEqual({
      kind: 'revise-pr',
      prRef: '7',
      repoSlug: 'o/r',
      repoPath: '/work',
      egress: false,
    });
  });

  it('parses --github-pr as an alternative to positional', () => {
    const cmd = parseCli(['revise-pr', '--github-pr', '42', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') expect(cmd.prRef).toBe('42');
  });

  it('returns help when the PR ref is missing', () => {
    expect(parseCli(['revise-pr'], '/work').kind).toBe('help');
  });

  it('parses --max-rounds', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--max-rounds', '3'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.maxRounds).toBe(3);
  });

  it('omits maxRounds when --max-rounds is not passed', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r'], '/work');
    expect(cmd.kind === 'revise-pr' && 'maxRounds' in cmd).toBe(false);
  });

  it('parses --llm-proxy', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--llm-proxy'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.llmProxy).toBe(true);
  });

  it('parses --review-model', () => {
    const cmd = parseCli(['revise-pr', '7', '--github-repo', 'o/r', '--review-model', 'sonnet'], '/work');
    expect(cmd.kind === 'revise-pr' && cmd.reviewModel).toBe('sonnet');
  });

  it('parses a GitHub PR URL', () => {
    const cmd = parseCli(['revise-pr', 'https://github.com/o/r/pull/99'], '/work');
    expect(cmd.kind).toBe('revise-pr');
    if (cmd.kind === 'revise-pr') {
      expect(cmd.prRef).toBe('https://github.com/o/r/pull/99');
    }
  });
});

describe('parseCli gitlab run', () => {
  it('parses --gitlab flag as gitlab source', () => {
    const cmd = parseCli(['run', '--gitlab', 'owner/project#42'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('owner/project#42');
  });

  it('parses --gitlab with --gitlab-project', () => {
    const cmd = parseCli(['run', '--gitlab', '42', '--gitlab-project', 'group/project'], '/repo');
    assert(cmd.kind === 'run');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.id).toBe('42');
    expect(cmd.project).toBe('group/project');
  });
});

describe('parseCli watch gitlab', () => {
  it('parses --source gitlab with --gitlab-project', () => {
    const cmd = parseCli(['watch', '--source', 'gitlab', '--gitlab-project', 'owner/project', '--label', 'vanguard'], '/repo');
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.project).toBe('owner/project');
    expect(cmd.label).toBe('vanguard');
  });

  it('parses --source gitlab with loop-v1 flags', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard',
       '--spec-label', 'ready for spec', '--agent-label', 'ready for agent', '--needs-info-label', 'needs info'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.source).toBe('gitlab');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });

  it('parses --source gitlab --loop-v1 with defaults', () => {
    const cmd = parseCli(
      ['watch', '--source', 'gitlab', '--gitlab-project', 'g/p', '--label', 'vanguard', '--loop-v1'],
      '/repo',
    );
    assert(cmd.kind === 'watch');
    expect(cmd.specLabel).toBe('ready for spec');
    expect(cmd.agentLabel).toBe('ready for agent');
    expect(cmd.needsInfoLabel).toBe('needs info');
  });
});

describe('parseCli review-mr', () => {
  it('parses review-mr with --mr and --gitlab-project', () => {
    const cmd = parseCli(['review-mr', '--mr', '42', '--gitlab-project', 'owner/project'], '/repo');
    assert(cmd.kind === 'review-mr');
    expect(cmd.iid).toBe(42);
    expect(cmd.project).toBe('owner/project');
  });
});

describe('parseCli watch-mrs', () => {
  it('parses watch-mrs with required flags', () => {
    const cmd = parseCli(['watch-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'watch-mrs');
    expect(cmd.project).toBe('g/p');
    expect(cmd.label).toBe('ready for review');
    expect(cmd.reviewingLabel).toBe('vanguard::reviewing');
    expect(cmd.reviewedLabel).toBe('vanguard::reviewed');
  });
});

describe('parseCli doctor-mrs', () => {
  it('parses doctor-mrs with required flags', () => {
    const cmd = parseCli(['doctor-mrs', '--gitlab-project', 'g/p', '--label', 'ready for review'], '/repo');
    assert(cmd.kind === 'doctor-mrs');
  });
});
