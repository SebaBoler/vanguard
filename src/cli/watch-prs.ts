import { githubPullRequestWatchPrimitives, watchPullRequests } from '../runners/pr-watch.js';
import { reviewPrCommand } from './review-pr.js';
import type { Command } from './args.js';
import type { GhRunner } from '../tasks/github.js';
import type { PullRequestWatchPrimitives, WatchPullRequestsLoopOptions } from '../runners/pr-watch.js';

type WatchPrsCommand = Extract<Command, { kind: 'watch-prs' }>;
type ReviewPrCommand = Extract<Command, { kind: 'review-pr' }>;

export type ReviewPrCommandRunner = (cmd: ReviewPrCommand) => Promise<void>;
export type WatchPullRequestsRunner = (
  primitives: PullRequestWatchPrimitives,
  opts: WatchPullRequestsLoopOptions,
) => Promise<void>;

export interface WatchPrsCommandDeps {
  gh?: GhRunner;
  reviewPr?: ReviewPrCommandRunner;
  watchPullRequests?: WatchPullRequestsRunner;
  log?: (line: string) => void;
}

/** Poll GitHub pull requests by label and run Vanguard's non-blocking review on each claimed PR. */
export async function watchPrsCommand(cmd: WatchPrsCommand, deps: WatchPrsCommandDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const reviewPr = deps.reviewPr ?? ((reviewCmd: ReviewPrCommand) => reviewPrCommand(reviewCmd));
  const runWatchPullRequests = deps.watchPullRequests ?? watchPullRequests;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const primitives = githubPullRequestWatchPrimitives({
    repoSlug: cmd.repoSlug,
    label: cmd.label,
    reviewingLabel: cmd.reviewingLabel,
    reviewedLabel: cmd.reviewedLabel,
    ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
    reviewOne: (item) =>
      reviewPr({
        kind: 'review-pr',
        prRef: String(item.number),
        repoSlug: item.repoSlug,
        repoPath: cmd.repoPath,
        egress: cmd.egress,
        ...(cmd.llmProxy === true ? { llmProxy: true } : {}),
        ...(cmd.provider !== undefined ? { provider: cmd.provider } : {}),
        ...(cmd.reviewModel !== undefined ? { reviewModel: cmd.reviewModel } : {}),
      }),
  });

  log(`watch-prs[github]: polling every ${cmd.intervalMs / 1000}s for PRs labeled "${cmd.label}". Ctrl-C to stop.`);
  try {
    await runWatchPullRequests(primitives, {
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
