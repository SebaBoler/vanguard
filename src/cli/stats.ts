import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMetrics, aggregateMetrics, formatStats } from '../core/stats.js';
import type { Command } from './args.js';

type StatsCommand = Extract<Command, { kind: 'stats' }>;

/** Read .vanguard/runs/metrics.jsonl and print an aggregated cost/token/time rollup. */
export async function statsCommand(cmd: StatsCommand): Promise<void> {
  const file = join(cmd.repoPath, '.vanguard', 'runs', 'metrics.jsonl');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.log(`No metrics found at ${file} — run a task first.`);
    return;
  }
  const records = parseMetrics(text);
  const report = aggregateMetrics(records);
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
