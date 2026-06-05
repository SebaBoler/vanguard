import { VanguardError } from '../core/errors.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const SKILLS_DIR = '/workspace/.vanguard/skills';

/** Maps skill ids to host directories and injects them into the sandbox before a run. */
export class SkillRegistry {
  constructor(private readonly skills: Record<string, string>) {}

  /** Inject the named skills to /workspace/.vanguard/skills (explicit, targeted). */
  async inject(ids: string[], sandbox: IsolatedSandboxProvider): Promise<void> {
    for (const id of ids) {
      const hostPath = this.skills[id];
      if (hostPath === undefined) throw new VanguardError(`Unknown skill: ${id}`);
      await sandbox.copyIn(hostPath, `${SKILLS_DIR}/${id}`);
    }
  }

  /**
   * Inject ALL registered skills into the agent's Claude skills directory ($HOME/.claude/skills),
   * where the claude CLI auto-discovers them and the model selects the relevant ones at runtime.
   */
  async injectAll(sandbox: IsolatedSandboxProvider, home: string): Promise<void> {
    for (const [id, hostPath] of Object.entries(this.skills)) {
      await sandbox.copyIn(hostPath, `${home}/.claude/skills/${id}`);
    }
  }
}
