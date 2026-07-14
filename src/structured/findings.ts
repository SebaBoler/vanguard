import { z } from 'zod';
import { extractJson } from './extract.js';
import { FINDING_SEVERITIES, FINDING_KINDS } from '../wire.js';

// Enum vocabularies live in src/wire.ts (the shared desktop contract — S7); zod derives from them.
const findingItemSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  kind: z.enum(FINDING_KINDS),
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
