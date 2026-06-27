export function reviewRequestBody(taskId: string, opts: { closeIssueOnMerge?: boolean } = {}): string {
  const base = `Automated implementation of ${taskId} by Vanguard.`;
  return opts.closeIssueOnMerge ? `Closes ${taskId}\n\n${base}` : base;
}
