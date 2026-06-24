import { formatPreflightReport, runPreflight } from './preflight.js';
import type { Command } from './args.js';
import type { PreflightOptions } from './preflight.js';

type DoctorMrsCommand = Extract<Command, { kind: 'doctor-mrs' }>;

export interface DoctorMrsOptions extends PreflightOptions {
  log?: (line: string) => void;
}

/** Print MR-watch readiness checks and fail before any merge request can be claimed. */
export async function doctorMrsCommand(cmd: DoctorMrsCommand, opts: DoctorMrsOptions = {}): Promise<void> {
  const report = await runPreflight(cmd, opts);
  const log = opts.log ?? console.log;
  for (const line of formatPreflightReport(report)) log(line);
  if (!report.ok) throw new Error('preflight failed');
}
