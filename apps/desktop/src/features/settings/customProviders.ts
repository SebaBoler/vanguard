import type { AppConfig } from '../../vanguard-output';

type Row = NonNullable<AppConfig['customProviders']>[number];

import { WIRE_PROVIDER_NAMES, FLOW_NAME_RE, KEY_ENV_RE, CUSTOM_PROVIDER_KEYS } from '../../wire';

/** Built-in provider names, from the generated wire contract (S7 — pinned to the registry in core). */
export const PROVIDERS: readonly string[] = WIRE_PROVIDER_NAMES;

// Constants come from wire (S7); this module keeps only the row predicate + UI copy. The core
// loader is still the one validity predicate and re-validates everything at run time (S6 §4).
const NAME_RE = FLOW_NAME_RE;
const ROW_KEYS: ReadonlySet<string> = new Set(CUSTOM_PROVIDER_KEYS);

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
  if (row.model === '') return 'model must be non-empty when set';
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
