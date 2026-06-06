import { z } from 'zod';
import { extractJson } from './extract.js';

export const findingsSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      kind: z.enum(['security', 'perf', 'correctness', 'style']),
      title: z.string(),
      evidence: z.string(),
    }),
  ),
});

export type Findings = z.infer<typeof findingsSchema>;
export type Finding = Findings['findings'][number];

/** Parse a <findings> JSON block emitted by an adversarial reviewer. */
export function extractFindings(text: string): Findings {
  return extractJson(text, 'findings', findingsSchema);
}
