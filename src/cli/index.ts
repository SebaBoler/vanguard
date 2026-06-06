#!/usr/bin/env node
import { parseCli, USAGE } from './args.js';
import { runGc } from './gc.js';

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2), process.cwd());
  if (command.kind === 'help') {
    console.log(USAGE);
    return;
  }
  const report = await runGc(command);
  const tag = command.dryRun ? ' (dry-run)' : '';
  const remote = command.remoteRepo !== undefined ? `, ${report.branches.length} merged remote branch(es)` : '';
  console.log(`Reaped ${report.containers.length} container(s)${remote}${tag}.`);
  if (report.containers.length > 0) console.log(`  containers: ${report.containers.join(', ')}`);
  if (report.branches.length > 0) console.log(`  branches: ${report.branches.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
