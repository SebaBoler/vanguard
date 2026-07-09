export type Finding = {
  severity: 'low' | 'medium' | 'high' | 'critical';
  kind: 'security' | 'perf' | 'correctness' | 'style';
  title: string;
  evidence: string;
};

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const KINDS = new Set(['security', 'perf', 'correctness', 'style']);

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
