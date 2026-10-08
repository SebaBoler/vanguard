// The Finding shape + vocabularies come from the generated wire contract (S7): the adversary
// stage's <findings> output is a real cross-boundary contract (core zod derives from the same
// arrays), and this was the one mirror with no sync header at all.
import { FINDING_SEVERITIES, FINDING_KINDS } from '../wire';
import type { Finding } from '../wire';
export type { Finding } from '../wire';

const SEVERITIES: ReadonlySet<string> = new Set(FINDING_SEVERITIES);
const KINDS: ReadonlySet<string> = new Set(FINDING_KINDS);

function isFinding(x: unknown): x is Finding {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.severity === 'string' &&
    SEVERITIES.has(f.severity) &&
    typeof f.kind === 'string' &&
    KINDS.has(f.kind) &&
    typeof f.title === 'string' &&
    typeof f.evidence === 'string'
  );
}

/** Parses a `<findings>` tag body. Accepts both `{"findings":[...]}` and a bare `[...]` — real adversary-stage output uses both shapes interchangeably. Returns null on any shape mismatch so the caller can fall back to raw rendering. */
export function parseFindings(inner: string): Finding[] | null {
  let json: unknown;
  try {
    json = JSON.parse(inner);
  } catch {
    return null;
  }
  const arr = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null && Array.isArray((json as { findings?: unknown }).findings)
      ? (json as { findings: unknown[] }).findings
      : null;
  if (arr === null || !arr.every(isFinding)) return null;
  return arr;
}
