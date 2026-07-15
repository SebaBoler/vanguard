export class VanguardError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class SandboxError extends VanguardError {}
export class WorktreeError extends VanguardError {}
export class AgentError extends VanguardError {}
export class NotImplementedError extends VanguardError {}
export class StructuredOutputError extends VanguardError {}
export class WorkflowGuardError extends VanguardError {}

/**
 * Normalise a raw thrown value into a user-visible VanguardError: an existing VanguardError passes
 * through untouched; anything else is wrapped with the first non-empty line of its message — where
 * CLIs like gh/glab/git put the actionable text. Shared by the board and repo-file read paths.
 */
export function visibleError(error: unknown): VanguardError {
  if (error instanceof VanguardError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new VanguardError(message.split('\n').find((l) => l.trim() !== '') ?? message);
}
