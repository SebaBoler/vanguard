#!/usr/bin/env node
import { parseCli, USAGE } from './args.js';
import { runGc } from './gc.js';
import { runCommand } from './run.js';
import { watchCommand } from './watch.js';
import { statsCommand } from './stats.js';
import { memoryCommand } from './memory.js';
import { doctorCommand } from './doctor.js';
import { doctorPrsCommand } from './doctor-prs.js';
import { reviewPrCommand } from './review-pr.js';
import { researchCommand } from './research.js';
import { specCommand } from './spec.js';
import { revisePrCommand } from './revise-pr.js';
import { watchPrsCommand } from './watch-prs.js';
import { reviewMrCommand } from './review-mr.js';
import { watchMrsCommand } from './watch-mrs.js';
import { doctorMrsCommand } from './doctor-mrs.js';
import { evalCommand } from './eval.js';

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2), process.cwd());
  if (command.kind === 'help') {
    console.log(USAGE);
    return;
  }
  if (command.kind === 'error') {
    console.error(`vanguard: ${command.message}`);
    process.exitCode = 1;
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
  if (command.kind === 'doctor-prs') {
    await doctorPrsCommand(command);
    return;
  }
  if (command.kind === 'review-pr') {
    await reviewPrCommand(command);
    return;
  }
  if (command.kind === 'research') {
    await researchCommand(command);
    return;
  }
  if (command.kind === 'spec') {
    await specCommand(command);
    return;
  }
  if (command.kind === 'revise-pr') {
    await revisePrCommand(command);
    return;
  }
  if (command.kind === 'watch-prs') {
    await watchPrsCommand(command);
    return;
  }
  if (command.kind === 'review-mr') {
    await reviewMrCommand(command);
    return;
  }
  if (command.kind === 'watch-mrs') {
    await watchMrsCommand(command);
    return;
  }
  if (command.kind === 'doctor-mrs') {
    await doctorMrsCommand(command);
    return;
  }
  if (command.kind === 'eval') {
    await evalCommand(command);
    return;
  }
  if (command.kind === 'stats') {
    await statsCommand(command);
    return;
  }
  if (command.kind === 'memory') {
    await memoryCommand(command);
    return;
  }
  if (command.kind === 'sidecar') {
    // The JSON protocol owns stdout. Route everything else to stderr so a stray log line can't
    // corrupt the stream the desktop parses: pino via VANGUARD_SIDECAR (see logger.ts), and the
    // runner's console.log/info (e.g. summarizeOutcomes, gate messages) redirected here.
    process.env.VANGUARD_SIDECAR = '1';
    console.log = (...args: unknown[]): void => console.error(...args);
    console.info = (...args: unknown[]): void => console.error(...args);
    const { runSidecar } = await import('../sidecar/sidecar.js');
    const { productionDeps } = await import('../sidecar/deps.js');
    const { installCancelHandler } = await import('../sidecar/cancel.js');
    const { createInterface } = await import('node:readline');
    installCancelHandler();
    const rl = createInterface({ input: process.stdin });
    await runSidecar(rl, (l: string) => void process.stdout.write(l + '\n'), productionDeps());
    return;
  }
  if (command.kind === 'complete') {
    // Same stdout discipline as the sidecar: the single JSON response line owns stdout, so a stray
    // log can't corrupt it. Set the gate BEFORE importing the SDK.
    process.env.VANGUARD_SIDECAR = '1';
    console.log = (...args: unknown[]): void => console.error(...args);
    console.info = (...args: unknown[]): void => console.error(...args);
    const [{ runComplete }, { authFromEnv }, { default: Anthropic }, { createInterface: mkRl }] = await Promise.all([
      import('../api/complete.js'),
      import('../agents/auth.js'),
      import('@anthropic-ai/sdk'),
      import('node:readline'),
    ]);
    type AnthropicLike = import('../api/complete.js').AnthropicLike;
    const rlc = mkRl({ input: process.stdin });
    const input = await new Promise<string>((resolve) => {
      rlc.once('line', (l: string) => {
        rlc.close();
        resolve(l);
      });
    });
    let req: unknown;
    try {
      req = JSON.parse(input);
    } catch {
      process.stdout.write(JSON.stringify({ error: { message: 'invalid request JSON' } }) + '\n');
      return;
    }
    const res = await runComplete(req, {
      authFromEnv: () => authFromEnv(),
      anthropic: (opts) => new Anthropic(opts) as unknown as AnthropicLike,
    });
    process.stdout.write(JSON.stringify(res) + '\n');
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
