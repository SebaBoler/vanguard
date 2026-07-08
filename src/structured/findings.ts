import { z } from 'zod';
import { extractJson } from './extract.js';

const findingItemSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  kind: z.enum(['security', 'perf', 'correctness', 'style']),
  title: z.string(),
  evidence: z.string(),
});

/** Accepts either a bare findings array or the wrapped-object shape; normalizes to the object shape. */
export const findingsSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { findings: v } : v),
  z.object({ findings: z.array(findingItemSchema) }),
);

export type Findings = z.infer<typeof findingsSchema>;
export type Finding = Findings['findings'][number];

/** Parse a <findings> JSON block emitted by an adversarial reviewer. */
export function extractFindings(text: string): Findings {
  return extractJson(text, 'findings', findingsSchema);
}
