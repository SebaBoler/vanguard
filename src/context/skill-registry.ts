import { VanguardError } from '../core/errors.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const SKILLS_DIR = '/workspace/.vanguard/skills';

/** Maps skill ids to host directories and injects them into the sandbox before a run. */
export class SkillRegistry {
  constructor(private readonly skills: Record<string, string>) {}

  async inject(ids: string[], sandbox: IsolatedSandboxProvider): Promise<void> {
    const resolved = ids.map((id) => {
      const hostPath = this.skills[id];
      if (hostPath === undefined) throw new VanguardError(`Unknown skill: ${id}`);
      return { id, hostPath };
    });
    await Promise.all(resolved.map(({ id, hostPath }) => sandbox.copyIn(hostPath, `${SKILLS_DIR}/${id}`)));
  }
}
