import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, skillRegistryFromDirectory } from './skill-registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

describe('SkillRegistry', () => {
  it('copies registered skills into the sandbox', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await new SkillRegistry({ lint: '/host/skills/lint' }).inject(['lint'], sandbox);
    expect(calls).toEqual([['/host/skills/lint', '/workspace/.vanguard/skills/lint']]);
  });

  it('throws on unknown skill id', async () => {
    await expect(new SkillRegistry({}).inject(['nope'], {} as IsolatedSandboxProvider)).rejects.toThrow(/nope/);
  });

  it('injects all registered skills into the agent skills dir for auto-discovery', async () => {
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await new SkillRegistry({ lint: '/host/lint', fmt: '/host/fmt' }).injectAll(sandbox, '/home/agent');
    expect(calls).toEqual([
      ['/host/lint', '/home/agent/.claude/skills/lint'],
      ['/host/fmt', '/home/agent/.claude/skills/fmt'],
    ]);
  });
});

describe('skillRegistryFromDirectory', () => {
  it('registers each subdirectory that contains a SKILL.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    await mkdir(join(dir, 'lint'), { recursive: true });
    await writeFile(join(dir, 'lint', 'SKILL.md'), '# lint');
    await mkdir(join(dir, 'fmt'), { recursive: true });
    await writeFile(join(dir, 'fmt', 'SKILL.md'), '# fmt');
    await mkdir(join(dir, 'not-a-skill'), { recursive: true });
    await writeFile(join(dir, 'not-a-skill', 'readme.txt'), 'x');

    const registry = await skillRegistryFromDirectory(dir);
    const calls: Array<[string, string]> = [];
    const sandbox = {
      copyIn: async (h: string, s: string): Promise<void> => {
        calls.push([h, s]);
      },
    } as unknown as IsolatedSandboxProvider;
    await registry.injectAll(sandbox, '/home/agent');
    const targets = calls.map(([, s]) => s).sort();
    expect(targets).toEqual(['/home/agent/.claude/skills/fmt', '/home/agent/.claude/skills/lint']);
    await rm(dir, { recursive: true, force: true });
  });
});
