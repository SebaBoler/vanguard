import { gitlabMergeRequestWatchPrimitives, watchMergeRequests } from '../runners/mr-watch.js';
import { reviewMrCommand } from './review-mr.js';
import { formatPreflightReport, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { MergeRequestWatchPrimitives, WatchMergeRequestsLoopOptions } from '../runners/mr-watch.js';

type WatchMrsCommand = Extract<Command, { kind: 'watch-mrs' }>;
type ReviewMrCommand = Extract<Command, { kind: 'review-mr' }>;

export type ReviewMrCommandRunner = (cmd: ReviewMrCommand) => Promise<void>;
export type WatchMergeRequestsRunner = (
  primitives: MergeRequestWatchPrimitives,
  opts: WatchMergeRequestsLoopOptions,
) => Promise<void>;

export interface WatchMrsCommandDeps {
  reviewMr?: ReviewMrCommandRunner;
  watchMergeRequests?: WatchMergeRequestsRunner;
  log?: (line: string) => void;
}

/** Poll GitLab MRs by label and run Vanguard's non-blocking review on each claimed MR. */
export async function watchMrsCommand(cmd: WatchMrsCommand, deps: WatchMrsCommandDeps = {}): Promise<void> {
  const report = await runPreflight(cmd);
  for (const line of formatPreflightReport(report)) console.log(line);
  if (!report.ok) throw new Error('preflight failed');

  const log = deps.log ?? console.log;
  const runReviewMr = deps.reviewMr ?? ((reviewCmd: ReviewMrCommand) => reviewMrCommand(reviewCmd));
  const runWatchMrs = deps.watchMergeRequests ?? watchMergeRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const primitives = gitlabMergeRequestWatchPrimitives({
    project: cmd.project,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    ...(cmd.author !== undefined ? { author: cmd.author } : {}),
    reviewOne: (item) =>
      runReviewMr({
        kind: 'review-mr',
        iid: item.iid,
        project: item.project,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
      }),
  });

  log(`watch-mrs[gitlab]: polling every ${cmd.intervalMs / 1000}s for MRs labeled "${cmd.label}". Ctrl-C to stop.`);
  try {
    await runWatchMrs(primitives, {
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal: controller.signal,
      log,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
