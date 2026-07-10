import type { AppConfig } from './vanguard-output';

/**
 * The single source of truth for the `vanguard` shell commands the desktop app launches.
 * Three call sites used to hardcode `--provider zai --llm-proxy` and drift apart; they all
 * route through here now.
 *
 * `--llm-proxy` is deliberately NOT emitted: it is provider-specific (the sidecar owns the
 * Anthropic transport), wrong for the subscription/OAuth providers most runs use, and rejected
 * outright by direct-only providers like meridian. The New Run command is editable, so a zai /
 * openrouter user adds `--llm-proxy` by hand.
 * ponytail: no per-provider proxy gating until a validated provider→proxy classification exists.
 */

/** Provider used when a project hasn't set one — a working local default (subscription/OAuth). */
export const DEFAULT_PROVIDER = 'claude';

/** `--max-turns` lifts the 12-turn implementer cap so non-trivial tasks can actually complete. */
const MAX_TURNS = 30;

const provider = (cfg: AppConfig): string => cfg.provider ?? DEFAULT_PROVIDER;

/** Default `vanguard run` command for a New Run — `<issue>` is left for the user to fill. */
export function runCommand(cfg: AppConfig, source: string = cfg.source ?? 'github'): string {
  return `vanguard run --${source} <issue> --provider ${provider(cfg)} --max-turns ${MAX_TURNS}`;
}

/** Fleet watch-loop command. */
export function watchCommand(
  cfg: AppConfig,
  opts: { source: string; concurrency: number; loopV1: boolean },
): string {
  const loop = opts.loopV1 ? ' --loop-v1' : '';
  return `vanguard watch --${opts.source} --concurrency ${opts.concurrency}${loop} --provider ${provider(cfg)} --max-turns ${MAX_TURNS}`;
}

/** Quick-fill presets for the New Run form, one per task source. */
export function runPresets(cfg: AppConfig): { label: string; cmd: string }[] {
  return [
    { label: 'Run issue', cmd: runCommand(cfg, 'github') },
    { label: 'Run (GitLab MR)', cmd: runCommand(cfg, 'gitlab') },
    { label: 'Run (Linear)', cmd: runCommand(cfg, 'linear') },
  ];
}
