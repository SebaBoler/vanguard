import { describe, it, expect } from 'vitest';
import { parseCli } from './args.js';

describe('parseCli', () => {
  it('defaults gc to cwd, 6h, no remote, not dry-run', () => {
    expect(parseCli(['gc'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/work',
      maxAgeMs: 6 * 60 * 60 * 1000,
      dryRun: false,
    });
  });

  it('parses gc options', () => {
    expect(parseCli(['gc', '--repo', '/r', '--max-age-hours', '2', '--remote', 'o/r', '--dry-run'], '/work')).toEqual({
      kind: 'gc',
      repoPath: '/r',
      maxAgeMs: 2 * 60 * 60 * 1000,
      remoteRepo: 'o/r',
      dryRun: true,
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
});
