#!/usr/bin/env node
import { parseCli, USAGE } from './args.js';
import { runGc } from './gc.js';
import { runCommand } from './run.js';
import { watchCommand } from './watch.js';
import { statsCommand } from './stats.js';
import { doctorCommand } from './doctor.js';

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2), process.cwd());
  if (command.kind === 'help') {
    console.log(USAGE);
    return;
  }
  if (command.kind === 'run') {
    await runCommand(command);
    return;
  }
  if (command.kind === 'watch') {
    await watchCommand(command);
    return;
  }
  if (command.kind === 'doctor') {
    await doctorCommand(command);
    return;
  }
  if (command.kind === 'stats') {
    await statsCommand(command);
    return;
  }
  const report = await runGc(command);
  const tag = command.dryRun ? ' (dry-run)' : '';
  const remote = command.remoteRepo !== undefined ? `, ${report.branches.length} merged remote branch(es)` : '';
  console.log(`Reaped ${report.containers.length} container(s), ${report.networks.length} egress network(s)${remote}${tag}.`);
  if (report.containers.length > 0) console.log(`  containers: ${report.containers.join(', ')}`);
  if (report.networks.length > 0) console.log(`  networks: ${report.networks.join(', ')}`);
  if (report.branches.length > 0) console.log(`  branches: ${report.branches.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
