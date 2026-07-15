import { renderConformanceFeedback, renderScopeChecklist } from '../pipeline/conformance-gate.js';
import type { ConformanceResult, SpecManifest } from '../pipeline/conformance-gate.js';

export interface ReviewRequestBodyOptions {
  closeIssueOnMerge?: boolean;
  /** Conformance gate result for the final diff. Omit (or `checked: false`) for legacy/no-manifest specs. */
  conformance?: ConformanceResult;
  /** Required alongside a `checked` conformance result — the manifest the checklist is rendered from. */
  manifest?: SpecManifest;
  /** Force the Part-of/non-closing path even when conformance passed (or wasn't checked) — set when verification (typecheck/tests) is red. */
  verificationFailed?: boolean;
  /** Same override for an implementer that never signalled COMPLETE (turn cap/timeout) — partial by definition. */
  implementerIncomplete?: boolean;
  /** White-label mode: drop the "Automated implementation … by Vanguard" attribution line entirely. */
  hideAttribution?: boolean;
}

/**
 * Build the PR body. Without a manifest-backed conformance result (legacy spec, or no spec at all)
 * this preserves the old behavior: `Closes #N` when auto-close is enabled, otherwise no closing
 * keyword. With a manifest-backed result, `Closes #N` is used ONLY when every obligation is met;
 * a partial diff gets `Part of #N` plus a checklist of what was delivered vs deferred, so partial
 * scope is declared instead of silently claiming completion. A red `verificationFailed` overrides
 * either path to `Part of #N` — a red test run must never ship as a silent `Closes`.
 */
export function reviewRequestBody(taskId: string, opts: ReviewRequestBodyOptions = {}): string {
  const { conformance, manifest, verificationFailed } = opts;
  // Either red signal forces the non-closing path: failing tests or an implementer that stopped
  // before finishing must never ship as a silent `Closes`.
  const red = verificationFailed === true || opts.implementerIncomplete === true;
  // White-label mode drops the attribution line; `join` then omits it (and its blank separator).
  const base = opts.hideAttribution === true ? undefined : `Automated implementation of ${taskId} by Vanguard.`;
  const join = (...parts: (string | undefined)[]): string =>
    parts.filter((p): p is string => p !== undefined && p !== '').join('\n\n');

  if (conformance === undefined || !conformance.checked || manifest === undefined) {
    if (red) return join(`Part of ${taskId}`, base);
    return opts.closeIssueOnMerge ? join(`Closes ${taskId}`, base) : (base ?? '');
  }

  const checklist = renderScopeChecklist(manifest, conformance);
  if (conformance.pass && !red) {
    return join(`Closes ${taskId}`, base, '## Spec conformance', checklist);
  }
  const gapDetail = conformance.pass
    ? verificationFailed === true
      ? 'Spec conformance passed, but verification (typecheck/tests) is currently failing.'
      : 'Spec conformance passed, but the implementer ended (turn cap or timeout) before signalling the task complete.'
    : renderConformanceFeedback(conformance);
  return join(
    `Part of ${taskId}`,
    base,
    '## Spec conformance (partial delivery)',
    'This PR does not cover the full spec. Deferred sections are unchecked below.',
    checklist,
    ['<details><summary>Conformance gap detail</summary>', '', gapDetail, '', '</details>'].join('\n'),
  );
}
