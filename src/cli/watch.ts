import { watchLinear } from '../runners/watch.js';
import { startEgressEnclave } from '../sandbox/egress-network.js';
import { authFromEnv } from '../agents/auth.js';
import type { RunLinearIssueDeps } from '../runners/linear.js';
import type { Command } from './args.js';

type WatchCommand = Extract<Command, { kind: 'watch' }>;

/** Run the autonomous Linear watch loop (poll -> claim -> run -> review), wiring deps + egress. */
export async function watchCommand(cmd: WatchCommand): Promise<void> {
  const auth = authFromEnv();
  if (auth === undefined) {
    throw new Error('Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API) before running.');
  }
  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey === undefined || linearKey === '') {
    throw new Error('Set LINEAR_API_KEY so Vanguard can read and update Linear issues.');
  }
  const skillsDir = cmd.skillsDir ?? process.env.SKILLS_DIR;
  if (skillsDir === undefined) {
    throw new Error('Pass --skills <dir> or set SKILLS_DIR (a clone of schpet/linear-cli /skills).');
  }
  const deps: RunLinearIssueDeps = { auth, linearKey, skillsDir, repoPath: cmd.repoPath };

  const enclave = cmd.egress ? await startEgressEnclave() : undefined;
  if (enclave !== undefined) {
    deps.proxyUrl = enclave.proxyUrl;
    deps.network = enclave.network;
    console.log('egress: sandbox confined to an internal network; only the allowlist proxy can reach out.');
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(
    `watch: polling Linear every ${cmd.intervalMs / 1000}s for ${cmd.triggerState} issues labeled "${cmd.label}"` +
      `${cmd.team !== undefined ? ` in ${cmd.team}` : ''}. Ctrl-C to stop.`,
  );
  try {
    await watchLinear({
      deps,
      label: cmd.label,
      triggerState: cmd.triggerState,
      claimedState: cmd.claimedState,
      reviewState: cmd.reviewState,
      concurrency: cmd.concurrency,
      intervalMs: cmd.intervalMs,
      once: cmd.once,
      signal: controller.signal,
      ...(cmd.team !== undefined ? { team: cmd.team } : {}),
    });
  } finally {
    if (enclave !== undefined) await enclave.destroy();
  }
}
