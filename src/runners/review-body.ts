import { renderConformanceFeedback, renderScopeChecklist } from '../pipeline/conformance-gate.js';
import type { ConformanceResult, SpecManifest } from '../pipeline/conformance-gate.js';

export interface ReviewRequestBodyOptions {
  closeIssueOnMerge?: boolean;
  /** Conformance gate result for the final diff. Omit (or `checked: false`) for legacy/no-manifest specs. */
  conformance?: ConformanceResult;
  /** Required alongside a `checked` conformance result — the manifest the checklist is rendered from. */
  manifest?: SpecManifest;
}

/**
 * Build the PR body. Without a manifest-backed conformance result (legacy spec, or no spec at all)
 * this preserves the old behavior: `Closes #N` when auto-close is enabled, otherwise no closing
 * keyword. With a manifest-backed result, `Closes #N` is used ONLY when every obligation is met;
 * a partial diff gets `Part of #N` plus a checklist of what was delivered vs deferred, so partial
 * scope is declared instead of silently claiming completion.
 */
export function reviewRequestBody(taskId: string, opts: ReviewRequestBodyOptions = {}): string {
  const base = `Automated implementation of ${taskId} by Vanguard.`;
  const { conformance, manifest } = opts;
  if (conformance === undefined || !conformance.checked || manifest === undefined) {
    return opts.closeIssueOnMerge ? `Closes ${taskId}\n\n${base}` : base;
  }

  const checklist = renderScopeChecklist(manifest, conformance);
  if (conformance.pass) {
    return [`Closes ${taskId}`, '', base, '', '## Spec conformance', '', checklist].join('\n');
  }
  return [
    `Part of ${taskId}`,
    '',
    base,
    '',
    '## Spec conformance (partial delivery)',
    '',
    'This PR does not cover the full spec. Deferred sections are unchecked below.',
    '',
    checklist,
    '',
    '<details><summary>Conformance gap detail</summary>',
    '',
    renderConformanceFeedback(conformance),
    '',
    '</details>',
  ].join('\n');
}
