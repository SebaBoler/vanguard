import { parseArgs } from 'node:util';

export type Command =
  | { kind: 'gc'; repoPath: string; maxAgeMs: number; remoteRepo?: string; dryRun: boolean }
  | {
      kind: 'run';
      source: 'linear' | 'github' | 'project';
      id: string;
      parent: boolean;
      gcBefore: boolean;
      egress: boolean;
      repoPath: string;
      concurrency: number;
      skillsDir?: string;
      repoSlug?: string;
      label?: string;
    }
  | { kind: 'help' };

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 6;
const DEFAULT_CONCURRENCY = 2;

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
        // gc
        repo: { type: 'string' },
        'max-age-hours': { type: 'string' },
        remote: { type: 'string' },
        'dry-run': { type: 'boolean' },
        // run
        linear: { type: 'string' },
        github: { type: 'string' },
        project: { type: 'string' },
        parent: { type: 'boolean' },
        'gc-before': { type: 'boolean' },
        egress: { type: 'boolean' },
        skills: { type: 'string' },
        'github-repo': { type: 'string' },
        label: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    return { kind: 'help' };
  }

  if (values.help === true) return { kind: 'help' };
  const repoPath = typeof values.repo === 'string' ? values.repo : cwd;

  if (positionals[0] === 'gc') {
    const hours = Number(values['max-age-hours']);
    const maxAgeMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_MAX_AGE_HOURS) * HOUR_MS;
    return {
      kind: 'gc',
      repoPath,
      maxAgeMs,
      dryRun: values['dry-run'] === true,
      ...(typeof values.remote === 'string' ? { remoteRepo: values.remote } : {}),
    };
  }

  if (positionals[0] === 'run') {
    const sources: Array<['linear' | 'github' | 'project', string]> = [];
    if (typeof values.linear === 'string') sources.push(['linear', values.linear]);
    if (typeof values.github === 'string') sources.push(['github', values.github]);
    if (typeof values.project === 'string') sources.push(['project', values.project]);
    // Exactly one source is required.
    const picked = sources[0];
    if (sources.length !== 1 || picked === undefined) return { kind: 'help' };
    const concurrency = Number(values.concurrency);
    return {
      kind: 'run',
      source: picked[0],
      id: picked[1],
      parent: values.parent === true,
      gcBefore: values['gc-before'] === true,
      egress: values.egress === true,
      repoPath,
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY,
      ...(typeof values.skills === 'string' ? { skillsDir: values.skills } : {}),
      ...(typeof values['github-repo'] === 'string' ? { repoSlug: values['github-repo'] } : {}),
      ...(typeof values.label === 'string' ? { label: values.label } : {}),
    };
  }

  return { kind: 'help' };
}

export const USAGE = `vanguard <command>

Commands:
  run    Run an agent on a task and open a draft PR for review.
  gc     Reap stale sandbox containers, prune worktrees, and (with --remote) delete merged
         remote vanguard/* branches.

  run options (exactly one source):
    --linear <ID>          Run a Linear issue (reads it via the in-sandbox linear-cli skill)
    --github <owner/repo#n> Run a GitHub issue
    --project <number>     Run every issue on a GitHub Projects v2 board (one run + PR each)
    --parent               (Linear) fan the issue's sub-tasks out, one run + PR each
    --label <name>         (project) only run board items with this label
    --gc-before            Reap stale sandboxes + prune worktrees before starting (clean slate)
    --egress               Restrict sandbox egress to an allowlist (anthropic/github/linear/registries)
    --repo <path>          Local git repo to work in (default: cwd)
    --skills <dir>         Skills directory to inject (Linear: the linear-cli skill)
    --github-repo <o/r>    GitHub repo slug (default: detected from origin)
    --concurrency <n>      (parent/project) max tasks at once (default: 2)

  gc options:
    --repo <path>          Git repo to prune worktrees / reap branches in (default: cwd)
    --max-age-hours <n>    Only reap resources older than n hours (default: 6)
    --remote <owner/repo>  Also delete merged remote vanguard/* branches (needs gh)
    --dry-run              List what would be reaped without removing anything

Env: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (auth); LINEAR_API_KEY (for --linear).
`;
