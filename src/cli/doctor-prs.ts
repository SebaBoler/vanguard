import { formatPreflightReport, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorPrsCommand = Extract<Command, { kind: 'doctor-prs' }>;

export interface DoctorPrsOptions extends PreflightOptions {
  log?: (line: string) => void;
}

/** Print PR-watch readiness checks and fail before any pull request can be claimed. */
export async function doctorPrsCommand(cmd: DoctorPrsCommand, opts: DoctorPrsOptions = {}): Promise<void> {
  const report = await runPreflight(cmd, opts);
  const log = opts.log ?? console.log;
  for (const line of formatPreflightReport(report)) log(line);
  if (!report.ok) throw new Error('preflight failed');
}
