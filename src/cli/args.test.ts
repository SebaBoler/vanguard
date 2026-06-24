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
