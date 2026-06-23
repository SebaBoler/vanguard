import { execa } from 'execa';
import { authFromEnv } from '../agents/auth.js';
import { providerSecrets, requiresApiKey, validateProviderChoice } from '../agents/registry.js';
import { GITHUB_CLAIMED_LABEL, GITHUB_REVIEW_LABEL, GITHUB_SPEC_CLAIMED_LABEL } from '../github-labels.js';
import type { ProviderName } from '../agents/registry.js';
import type { Command } from './args.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;
type DoctorCommand = Extract<Command, { kind: 'doctor' }>;
type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;
export type PreflightCommand = WatchCommand | DoctorCommand | DoctorPrsCommand;

export type PreflightRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string }>;

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  run?: PreflightRunner;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  reason?: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

const MIN_NODE_MAJOR = 24;
const SANDBOX_IMAGE = 'vanguard-sandbox:latest';

const defaultRunner: PreflightRunner = async (cmd, args, opts) => {
  const { stdout } = await execa(cmd, args, { cwd: opts.cwd });
  return { stdout };
};

function check(name: string, ok: boolean, reason?: string): PreflightCheck {
  return reason === undefined ? { name, ok } : { name, ok, reason };
}

function parseNodeMajor(version: string): number {
  return Number(version.split('.')[0] ?? NaN);
}

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== '';
}

function repoSlugFromRemote(remote: string): string | undefined {
  return remote.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value !== ''))];
}

function githubLabelsFor(cmd: PreflightCommand): string[] {
  if (cmd.kind === 'doctor-prs') return unique([cmd.label, cmd.reviewingLabel, cmd.reviewedLabel]);
  if (cmd.source !== 'github') return [];
  if (cmd.specLabel !== undefined) {
    return unique([
      cmd.label,
      cmd.specLabel,
      cmd.agentLabel,
      cmd.needsInfoLabel,
      cmd.specClaimedLabel ?? GITHUB_SPEC_CLAIMED_LABEL,
      cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
      cmd.reviewState ?? GITHUB_REVIEW_LABEL,
    ]);
  }
  return unique([
    cmd.label,
    cmd.claimedState ?? GITHUB_CLAIMED_LABEL,
    cmd.reviewState ?? GITHUB_REVIEW_LABEL,
  ]);
}

async function runOk(run: PreflightRunner, cwd: string, cmd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await run(cmd, args, { cwd });
    return { ok: true, stdout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.split('\n')[0] ?? message };
  }
}

async function githubAuthOk(run: PreflightRunner, cwd: string, env: NodeJS.ProcessEnv): Promise<PreflightCheck> {
  if (hasEnv(env, 'GH_TOKEN') || hasEnv(env, 'GITHUB_TOKEN')) return check('github auth', true);
  const status = await runOk(run, cwd, 'gh', ['auth', 'status']);
  return status.ok ? check('github auth', true) : check('github auth', false, 'missing');
}

async function githubLabelsOk(run: PreflightRunner, cwd: string, repoSlug: string, required: string[]): Promise<PreflightCheck> {
  const labels = await runOk(run, cwd, 'gh', ['label', 'list', '--repo', repoSlug, '--json', 'name', '--limit', '200']);
  if (!labels.ok) return check('github labels', false, 'unreadable');
  let parsed: Array<{ name?: string }>;
  try {
    parsed = JSON.parse(labels.stdout) as Array<{ name?: string }>;
  } catch {
    return check('github labels', false, 'unreadable');
  }
  const existing = new Set(parsed.map((label) => label.name).filter((name): name is string => name !== undefined));
  const missing = required.filter((label) => !existing.has(label));
  return missing.length === 0 ? check('github labels', true) : check('github labels', false, `missing ${missing.join(', ')}`);
}

/**
 * Verify the repo allows Actions to create PRs ("Allow GitHub Actions to create and approve pull
 * requests"). Without it the agent does all the work then `gh pr create` fails. Best-effort: the
 * in-Action GITHUB_TOKEN often lacks `administration:read`, so an unreadable setting yields no check
 * (returns undefined) rather than a false failure — only an explicit `false` fails.
 */
async function prCreateSettingOk(run: PreflightRunner, cwd: string, repoSlug: string): Promise<PreflightCheck | undefined> {
  const res = await runOk(run, cwd, 'gh', ['api', `repos/${repoSlug}/actions/permissions/workflow`]);
  if (!res.ok) return undefined; // cannot read (token scope) — skip rather than assert ok or fail
  try {
    const parsed = JSON.parse(res.stdout) as { can_approve_pull_request_reviews?: boolean };
    return parsed.can_approve_pull_request_reviews === false
      ? check('pr-create setting', false, 'disabled — enable Settings > Actions > "Allow GitHub Actions to create and approve pull requests"')
      : check('pr-create setting', true);
  } catch {
    return undefined;
  }
}

/**
 * Validate a subscription-mode CODEX_AUTH_JSON before the run: it must be a JSON object carrying
 * `auth_mode` and a non-empty `tokens.refresh_token` (the contents of ~/.codex/auth.json). Catches an
 * empty/pretty-printed/garbled secret at preflight instead of opaquely inside codex. Returns undefined
 * when the var is unset (API-key mode is already covered by the 'provider auth' check).
 */
function codexAuthOk(env: NodeJS.ProcessEnv): PreflightCheck | undefined {
  const raw = env.CODEX_AUTH_JSON;
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as { auth_mode?: unknown; tokens?: { refresh_token?: unknown } };
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    const ok = typeof parsed.auth_mode === 'string' && typeof parsed.tokens?.refresh_token === 'string' && parsed.tokens.refresh_token !== '';
    return ok ? check('codex auth', true) : check('codex auth', false, 'CODEX_AUTH_JSON missing auth_mode or tokens.refresh_token');
  } catch {
    return check('codex auth', false, 'CODEX_AUTH_JSON is not valid JSON (use the contents of ~/.codex/auth.json)');
  }
}

/**
 * Collect the set of providers that need a host-key check (i.e. non-claude providers that
 * require an explicit API key). Claude is excluded — its auth is already covered by the llm auth check.
 */
function collectProviders(cmd: PreflightCommand): ProviderName[] {
  const candidates = cmd.kind === 'doctor-prs' ? [cmd.provider] : [cmd.provider, cmd.reviewProvider];
  // Zai is excluded here: it rides the Claude transport and its key is already covered by the
  // provider-aware 'llm auth' check above. Codex/Cursor still get a dedicated 'provider auth' check.
  return candidates.filter((name): name is ProviderName => name !== undefined && requiresApiKey(name));
}

/** Run AFK-readiness checks before a watch loop can claim work. */
export async function runPreflight(cmd: PreflightCommand, opts: PreflightOptions = {}): Promise<PreflightReport> {
  const env = opts.env ?? process.env;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const run = opts.run ?? defaultRunner;
  const checks: PreflightCheck[] = [];

  const nodeMajor = parseNodeMajor(nodeVersion);
  checks.push(
    Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
      ? check('node 24', true)
      : check('node 24', false, `found ${nodeVersion}`),
  );

  // The primary LLM auth: Anthropic token by default, or ZAI_API_KEY for --provider zai (zai owns its
  // transport and never needs an Anthropic credential). Reported concisely as 'missing' so the
  // preflight summary stays one line; the detailed requirement surfaces when the runner runs.
  const llmAuthPresent = cmd.provider === 'zai' ? hasEnv(env, 'ZAI_API_KEY') : authFromEnv(env) !== undefined;
  checks.push(llmAuthPresent ? check('llm auth', true) : check('llm auth', false, 'missing'));

  const usedProviders = collectProviders(cmd);
  if (usedProviders.length > 0) {
    try {
      providerSecrets(usedProviders, env, { proxyMode: cmd.llmProxy === true });
      checks.push(check('provider auth', true));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check('provider auth', false, message));
    }
  }

  // Subscription-mode Codex: validate the auth.json shape before the run (only when codex is selected).
  if (usedProviders.includes('codex')) {
    const codexCheck = codexAuthOk(env);
    if (codexCheck !== undefined) checks.push(codexCheck);
  }

  try {
    validateProviderChoice(
      {
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...('reviewProvider' in cmd && cmd.reviewProvider !== undefined ? { reviewProvider: cmd.reviewProvider } : {}),
      },
      { proxyMode: 'llmProxy' in cmd && cmd.llmProxy === true },
    );
    checks.push(check('provider combo', true));
  } catch (error) {
    checks.push(check('provider combo', false, error instanceof Error ? error.message : String(error)));
  }

  const gitRoot = await runOk(run, cmd.repoPath, 'git', ['rev-parse', '--show-toplevel']);
  const remote = gitRoot.ok ? await runOk(run, cmd.repoPath, 'git', ['remote', 'get-url', 'origin']) : gitRoot;
  checks.push(remote.ok ? check('repo remote', true) : check('repo remote', false, 'missing'));

  const dockerInfo = await runOk(run, cmd.repoPath, 'docker', ['info']);
  checks.push(dockerInfo.ok ? check('docker daemon', true) : check('docker daemon', false, 'unavailable'));

  const sandboxImage = await runOk(run, cmd.repoPath, 'docker', ['image', 'inspect', SANDBOX_IMAGE]);
  checks.push(sandboxImage.ok ? check('sandbox image', true) : check('sandbox image', false, `missing ${SANDBOX_IMAGE}`));

  const isGithubBacked = cmd.kind === 'doctor-prs' || cmd.source === 'github' || cmd.source === 'project';
  if (isGithubBacked) {
    checks.push(await githubAuthOk(run, cmd.repoPath, env));
  }

  if (cmd.kind === 'doctor-prs' || cmd.source === 'github') {
    const repoSlug = cmd.repoSlug ?? (remote.ok ? repoSlugFromRemote(remote.stdout) : undefined);
    if (repoSlug === undefined) {
      checks.push(check('github labels', false, 'repo unknown'));
    } else {
      checks.push(await githubLabelsOk(run, cmd.repoPath, repoSlug, githubLabelsFor(cmd)));
      const prCreate = await prCreateSettingOk(run, cmd.repoPath, repoSlug);
      if (prCreate !== undefined) checks.push(prCreate);
    }
  }

  if (cmd.kind !== 'doctor-prs' && cmd.source === 'linear') {
    checks.push(hasEnv(env, 'LINEAR_API_KEY') ? check('linear api', true) : check('linear api', false, 'missing'));
    checks.push(cmd.skillsDir !== undefined || hasEnv(env, 'SKILLS_DIR') ? check('linear skills', true) : check('linear skills', false, 'missing'));
  }

  return { ok: checks.every((item) => item.ok), checks };
}

export function formatPreflightReport(report: PreflightReport): string[] {
  return report.checks.map((item) => {
    if (item.ok) return `preflight: ${item.name} ok`;
    return `preflight: ${item.name} ${item.reason ?? 'failed'} -> stop before claim`;
  });
}
