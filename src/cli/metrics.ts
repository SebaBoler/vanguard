import { pushMetrics } from '../core/metrics-branch.js';
import type { Command } from './args.js';

type MetricsCommand = Extract<Command, { kind: 'metrics' }>;

/** `vanguard metrics push`: persist this checkout's metric lines on the metrics branch. */
export async function metricsCommand(cmd: MetricsCommand): Promise<void> {
  const result = await pushMetrics(cmd.repoPath, cmd.branch !== undefined ? { branch: cmd.branch } : {});
  console.log(
    result.pushed === 0
      ? `vanguard metrics: nothing new to push (${result.branch} holds ${result.total} lines)`
      : `vanguard metrics: pushed ${result.pushed} line${result.pushed === 1 ? '' : 's'} to ${result.branch} (${result.total} total)`,
  );
}
