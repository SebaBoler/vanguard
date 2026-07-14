import type { AppConfig } from '../../vanguard-output';

type Row = NonNullable<AppConfig['customProviders']>[number];

/** Built-in provider names — mirrors core PROVIDER_NAMES (manual-mirror discipline, like RunEvent). */
export const PROVIDERS = ['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian'];

/** Grammar mirrors of the core predicate (src/agents/custom.ts) — inline feedback only; the core
 *  loader is the one validity predicate and re-validates everything at run time (S6 §4). */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ROW_KEYS = new Set(['name', 'baseUrl', 'keyEnv', 'model']);

/** First violated rule for a Settings custom-provider row, or undefined when saveable. */
export function customProviderRowError(row: Row, index: number, all: Row[]): string | undefined {
  // Rows loaded from a hand-edited file can carry keys the editor doesn't know; the core loader
  // rejects them at run time, so showing such a row as healthy here would green-light a provider
  // the run refuses (review #341 obs 2). Unknown keys survive save untouched (Rust raw Value).
  const unknown = Object.keys(row).find((k) => !ROW_KEYS.has(k));
  if (unknown !== undefined) return `unknown key "${unknown}" — remove it from app.json (allowed: name, baseUrl, keyEnv, model)`;
  if (!NAME_RE.test(row.name)) return 'name must be lowercase letters/digits/._- (start with a letter or digit)';
  if (PROVIDERS.includes(row.name)) return `"${row.name}" is a built-in provider name`;
  if (all.findIndex((r) => r.name === row.name) !== index) return `duplicate provider name "${row.name}"`;
  if (!/^https?:\/\//.test(row.baseUrl) || !isUrl(row.baseUrl)) return 'base URL must be an absolute http:// or https:// URL';
  if (!KEY_ENV_RE.test(row.keyEnv)) return 'key env var must be a valid environment variable name';
  if (row.model !== undefined && row.model === '') return 'model must be non-empty when set';
  return undefined;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
