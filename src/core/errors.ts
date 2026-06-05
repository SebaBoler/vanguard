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
