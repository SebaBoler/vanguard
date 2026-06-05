import { join } from 'node:path';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

/** Mirror of the Agent SDK rule: absolute cwd with every non-alphanumeric char -> '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Location of a session transcript inside the sandbox: $HOME/.claude/projects/<enc>/<id>.jsonl */
export function sessionPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${encodeCwd(cwd)}/${sessionId}.jsonl`;
}

export interface CaptureOptions {
  home: string;
  cwd: string;
  sessionId: string;
  hostDir: string;
}

/** Pull the session jsonl out of the sandbox to host for token-saving resume. Returns host path. */
export async function captureSession(sandbox: IsolatedSandboxProvider, options: CaptureOptions): Promise<string> {
  const dest = join(options.hostDir, `${options.sessionId}.jsonl`);
  await sandbox.copyFileOut(sessionPath(options.home, options.cwd, options.sessionId), dest);
  return dest;
}

export interface RestoreOptions {
  home: string;
  cwd: string;
  sessionId: string;
  hostFile: string;
}

/** Restore a previously captured jsonl into a fresh sandbox before resume/fork. */
export async function restoreSession(sandbox: IsolatedSandboxProvider, options: RestoreOptions): Promise<void> {
  await sandbox.copyIn(options.hostFile, sessionPath(options.home, options.cwd, options.sessionId));
}
