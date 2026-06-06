import { parseArgs } from 'node:util';

export type Command =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean }
  | { kind: 'help' };

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;

/**
 * Parse argv (without the node/script prefix) into a typed command. Pure: cwd is passed in so this is
 * unit-testable. Unknown options or a missing/unknown command resolve to `help`.
 */
export function parseCli(argv: string[], cwd: string): Command {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        'max-age-hours': { type: 'string' },
        remote: { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    return { kind: 'help' };
  }

  if (values.help === true || positionals[0] !== 'gc') return { kind: 'help' };

  const hours = Number(values['max-age-hours']);
  const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
  return {
    kind: 'gc',
    repoPath: typeof values.repo === 'string' ? values.repo : cwd,
    maxAgeMs,
    dryRun: values['dry-run'] === true,
    ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
  };
}

export const USAGE = `vanguard <command>

Commands:
  gc    Reap stale sandbox containers, prune worktrees, and (with --remote) delete merged
        remote vanguard/* branches.

  gc options:
    --repo <path>          Git repo to prune worktrees / reap branches in (default: cwd)
    --max-age-hours <n>    Only reap resources older than n hours (default: 6)
    --remote <owner/repo>  Also delete merged remote vanguard/* branches (needs gh)
    --dry-run              List what would be reaped without removing anything
`;
