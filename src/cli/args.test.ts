import { describe, it, expect } from 'vitest';
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

  it('returns help for an unknown provider name', () => {
    expect(parseCli(['run', '--linear', 'TES-1', '--provider', 'gpt'], '/work').kind).toBe('help');
    expect(parseCli(['run', '--linear', 'TES-1', '--review-provider', 'bard'], '/work').kind).toBe('help');
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

  it('watch requires --label', () => {
    expect(parseCli(['watch'], '/work').kind).toBe('help');
  });

  it('returns help when run has no source or more than one source', () => {
    expect(parseCli(['run'], '/work').kind).toBe('help');
    expect(parseCli(['run', '--linear', 'A', '--github', 'B'], '/work').kind).toBe('help');
    expect(parseCli(['run', '--github', 'A', '--project', '3'], '/work').kind).toBe('help');
  });
});
