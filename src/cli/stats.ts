import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMetrics, parseProbes, aggregateMetrics, formatStats } from '../core/stats.js';
import { readBranchMetrics } from '../core/metrics-branch.js';
import type { Command } from './args.js';

type StatsCommand = Extract<Command, { kind: 'stats' }>;

/**
 * Read metrics.jsonl — the local .vanguard/runs copy, or with --branch the durable copy `metrics push`
 * keeps on the metrics branch — and print an aggregated cost/token/time rollup.
 */
export async function statsCommand(cmd: StatsCommand): Promise<void> {
  let text: string;
  if (cmd.branch !== undefined) {
    text = await readBranchMetrics(cmd.repoPath, { branch: cmd.branch });
    if (text === '') {
      console.log(`No metrics on branch ${cmd.branch} — has \`vanguard metrics push\` run yet?`);
      return;
    }
  } else {
    const file = join(cmd.repoPath, '.vanguard', 'runs', 'metrics.jsonl');
    try {
      text = await readFile(file, 'utf8');
    } catch {
      console.log(`No metrics found at ${file} — run a task first.`);
      return;
    }
  }
  const records = parseMetrics(text);
  const report = aggregateMetrics(records, parseProbes(text));
  if (cmd.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log('No run_complete metrics yet.');
    return;
  }
  console.log(formatStats(report));
}
