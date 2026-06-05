import { NotImplementedError } from '../core/errors.js';
import type { AgentProvider, AgentRunInput, AgentTurn, AgentRunOutput } from './provider.js';

/** Phase-2 placeholder. Satisfies AgentProvider so it slots in later without refactor. */
export class PiProvider implements AgentProvider {
  readonly name = 'pi';

  async *run(_input: AgentRunInput): AsyncGenerator<AgentTurn, AgentRunOutput, void> {
    throw new NotImplementedError('Pi provider — Faza 2');
  }
}
