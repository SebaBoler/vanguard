import { readFile } from 'node:fs/promises';
import {
  buildRetrospectiveMemory,
  renderRetrospectiveMarkdown,
  refreshRetrospectiveMemory,
  writeRetrospectiveMarkdown,
} from '../core/retrospective-memory.js';
import type { Command } from './args.js';

type MemoryCommand = Extract<Command, { kind: 'memory' }>;

/** Refresh .vanguard/memory/retrospective.md from run artifacts, then print it (or the raw report with --json). */
export async function memoryCommand(cmd: MemoryCommand): Promise<void> {
  // exactOptionalPropertyTypes: omit `limit` entirely when absent so the builder default applies.
  const opts = cmd.limit !== undefined ? { limit: cmd.limit } : {};
  if (cmd.json) {
    // Scan once: build the report, then reuse it to write the file (no second scan).
    const report = await buildRetrospectiveMemory(cmd.repoPath, opts);
    const md = renderRetrospectiveMarkdown(report);
    await writeRetrospectiveMarkdown(cmd.repoPath, md);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const path = await refreshRetrospectiveMemory(cmd.repoPath, opts);
  console.log(await readFile(path, 'utf8'));
}
