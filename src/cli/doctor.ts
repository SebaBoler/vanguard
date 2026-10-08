import { formatPreflightReport, runPreflight, SANDBOX_CLI_CHECK } from './preflight.js';
import { SANDBOX_CLAUDE_VERSION, refreshSandboxClaudeCli } from '../sandbox/docker.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

export interface DoctorOptions extends PreflightOptions {
  log?: (line: string) => void;
}

/** Print AFK-readiness checks and fail before any task can be claimed. */
export async function doctorCommand(cmd: DoctorCommand, opts: DoctorOptions = {}): Promise<void> {
  const log = opts.log ?? console.log;
  let report = await runPreflight(cmd, opts);

  // --fix repairs the one failure that has a safe, deterministic remedy: a sandbox image whose
  // bundled claude CLI predates the repo pin. Deliberately a separate, explicit command rather than
  // something a run does on its own — it needs the network and rewrites an image other sandboxes share.
  if (!report.ok && cmd.fix === true && report.checks.some((c) => c.name === SANDBOX_CLI_CHECK && !c.ok)) {
    log(`doctor --fix: installing claude ${SANDBOX_CLAUDE_VERSION} into the sandbox image`);
    await refreshSandboxClaudeCli({ cwd: cmd.repoPath, ...(opts.run !== undefined ? { run: opts.run } : {}) });
    report = await runPreflight(cmd, opts);
  }

  for (const line of formatPreflightReport(report)) log(line);
  if (!report.ok) throw new Error('preflight failed');
}
