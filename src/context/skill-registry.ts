import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { VanguardError } from '../core/errors.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const SKILLS_DIR = '/workspace/.vanguard/skills';

/** Maps skill ids to host directories and injects them into the sandbox before a run. */
export class SkillRegistry {
  constructor(private readonly skills: Record<string, string>) {}

  /** Inject the named skills to /workspace/.vanguard/skills (explicit, targeted). */
  async inject(ids: string[], sandbox: IsolatedSandboxProvider): Promise<void> {
    const resolved = ids.map((id) => {
      const hostPath = this.skills[id];
      if (hostPath === undefined) throw new VanguardError(`Unknown skill: ${id}`);
      return { id, hostPath };
    });
    await Promise.all(resolved.map(({ id, hostPath }) => sandbox.copyIn(hostPath, `${SKILLS_DIR}/${id}`)));
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

/**
 * Build a registry from a directory where each subdirectory containing a SKILL.md is a skill
 * (the Claude Code skill format used by collections like obra/superpowers and cursor-team-kit).
 * Combine with SkillRegistry.injectAll so the agent auto-discovers and selects them.
 */
export async function skillRegistryFromDirectory(dir: string): Promise<SkillRegistry> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    try {
      await stat(join(skillDir, 'SKILL.md'));
      skills[entry.name] = skillDir;
    } catch {
      // not a skill directory; skip
    }
  }
  return new SkillRegistry(skills);
}
