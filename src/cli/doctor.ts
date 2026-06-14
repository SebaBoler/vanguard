import { formatPreflightReport, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorCommand = Extract<Command, { kind: 'doctor' }>;

export interface DoctorOptions extends PreflightOptions {
  log?: (line: string) => void;
}

/** Print AFK-readiness checks and fail before any task can be claimed. */
export async function doctorCommand(cmd: DoctorCommand, opts: DoctorOptions = {}): Promise<void> {
  const report = await runPreflight(cmd, opts);
  const log = opts.log ?? console.log;
  for (const line of formatPreflightReport(report)) log(line);
  if (!report.ok) throw new Error('preflight failed');
}
