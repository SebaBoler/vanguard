/**
 * Normalize a Vanguard taskId to a `source-ref` key so a board id matches a run record.
 * The board mints `gh-<n>`, but a runner mints `gh-<repoSlug>-<n>` (e.g. `gh-owner-repo-904`);
 * both must fold to `gh-904` for run-history matching. Mirrors `taskid.rs` (trailing number for
 * gh/gl, whole identifier for linear). Anything else is returned lowercased, unchanged.
 */
export function taskRefKey(taskId: string): string {
  const lower = taskId.toLowerCase();
  if (lower.startsWith('linear-')) return lower;
  const m = lower.match(/^(gh|gl)-.*?(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : lower;
}
