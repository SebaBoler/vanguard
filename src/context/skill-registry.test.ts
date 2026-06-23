import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry, skillRegistryFromDirectory, parseSkillMeta } from './skill-registry.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

interface FakeSandbox {
  sandbox: IsolatedSandboxProvider;
  copies: Array<[string, string]>;
}

function makeSandbox(overrides: {
  exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onCopyIn?: (h: string, s: string) => Promise<void>;
} = {}): FakeSandbox {
  const copies: Array<[string, string]> = [];
  const defaultExec = async (): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ({ stdout: '', stderr: '', exitCode: 0 });
  const sandbox = {
    copyIn: async (h: string, s: string): Promise<void> => {
      copies.push([h, s]);
      await overrides.onCopyIn?.(h, s);
    },
    exec: overrides.exec ?? defaultExec,
  } as unknown as IsolatedSandboxProvider;
  return { sandbox, copies };
}

function makeContentCapturingSandbox(opts: { existingAgentsMd?: string; codexHome?: string } = {}): FakeSandbox & {
  fileContents: Record<string, string>;
} {
  const fileContents: Record<string, string> = {};
  const base = makeSandbox({
    onCopyIn: async (h, s) => {
      fileContents[s] = await readFile(h, 'utf-8').catch(() => '');
    },
    exec: async (cmd): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd.includes('CODEX_HOME') && cmd.startsWith('printf')) {
        return { stdout: opts.codexHome ?? '', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith('cat ') && cmd.includes('AGENTS.md')) {
        return { stdout: opts.existingAgentsMd ?? '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  return { ...base, fileContents };
}

describe('SkillRegistry.inject', () => {
  it('copies registered skills into the sandbox', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/skills/lint' }).inject(['lint'], sandbox);
    expect(copies).toEqual([['/host/skills/lint', '/workspace/.vanguard/skills/lint']]);
  });

  it('throws on unknown skill id', async () => {
    await expect(new SkillRegistry({}).inject(['nope'], {} as IsolatedSandboxProvider)).rejects.toThrow(/nope/);
  });
});

describe('SkillRegistry.injectAll — claude family', () => {
  it('injects all skills into ~/.claude/skills for claude-code', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/lint', fmt: '/host/fmt' }).injectAll(sandbox, '/home/agent', 'claude-code');
    expect(copies).toEqual([
      ['/host/lint', '/home/agent/.claude/skills/lint'],
      ['/host/fmt', '/home/agent/.claude/skills/fmt'],
    ]);
  });

  it('injects all skills into ~/.claude/skills for zai', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/lint' }).injectAll(sandbox, '/home/agent', 'zai');
    expect(copies).toEqual([['/host/lint', '/home/agent/.claude/skills/lint']]);
  });

  it('defaults to claude path when agentName is omitted', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/lint' }).injectAll(sandbox, '/home/agent');
    expect(copies).toEqual([['/host/lint', '/home/agent/.claude/skills/lint']]);
  });

  it('defaults to claude path for pi provider', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/lint' }).injectAll(sandbox, '/home/agent', 'pi');
    expect(copies).toEqual([['/host/lint', '/home/agent/.claude/skills/lint']]);
  });

  it('defaults to claude path for unknown provider', async () => {
    const { sandbox, copies } = makeSandbox();
    await new SkillRegistry({ lint: '/host/lint' }).injectAll(sandbox, '/home/agent', 'unknown-provider');
    expect(copies).toEqual([['/host/lint', '/home/agent/.claude/skills/lint']]);
  });
});

describe('SkillRegistry.injectAll — codex branch', () => {
  it('copies skill bodies and writes AGENTS.md to ~/.codex/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'lint'), { recursive: true });
      await writeFile(
        join(dir, 'lint', 'SKILL.md'),
        '---\nname: lint\ndescription: Run the linter.\n---\n# Lint\n',
      );
      await mkdir(join(dir, 'fmt'), { recursive: true });
      await writeFile(
        join(dir, 'fmt', 'SKILL.md'),
        '---\nname: fmt\ndescription: Format the code.\n---\n# Fmt\n',
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, copies } = makeSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      // Bodies are copied to .vanguard/skills/<id>
      const bodyCopies = copies.filter(([, s]) => s.startsWith('/workspace/.vanguard/skills/'));
      expect(bodyCopies.map(([, s]) => s).sort()).toEqual([
        '/workspace/.vanguard/skills/fmt',
        '/workspace/.vanguard/skills/lint',
      ]);

      // AGENTS.md is written to ~/.codex/AGENTS.md (host temp → sandbox)
      const agentsMdCopy = copies.find(([, s]) => s === '/home/agent/.codex/AGENTS.md');
      expect(agentsMdCopy).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('AGENTS.md content includes name, description, pointer and excludes body text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'myskill'), { recursive: true });
      await writeFile(
        join(dir, 'myskill', 'SKILL.md'),
        '---\nname: my-skill\ndescription: Do something useful.\n---\n# My Skill\nThis is the body — should NOT appear in AGENTS.md.\n',
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, fileContents } = makeContentCapturingSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      expect(fileContents['/home/agent/.codex/AGENTS.md']).toBeDefined();
      const agentsMdContent = fileContents['/home/agent/.codex/AGENTS.md'] ?? '';
      expect(agentsMdContent).toContain('my-skill');
      expect(agentsMdContent).toContain('Do something useful.');
      expect(agentsMdContent).toContain('.vanguard/skills/myskill/SKILL.md');
      expect(agentsMdContent).not.toContain('This is the body');
      expect(agentsMdContent).toContain('<!-- vanguard-skills:start -->');
      expect(agentsMdContent).toContain('<!-- vanguard-skills:end -->');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves existing Codex AGENTS.md content and replaces only the Vanguard block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'lint'), { recursive: true });
      await writeFile(join(dir, 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint.\n---\n');
      const existing = [
        '# User instructions',
        '',
        'Keep this.',
        '',
        '<!-- vanguard-skills:start -->',
        'old generated content',
        '<!-- vanguard-skills:end -->',
        '',
        'Keep this too.',
        '',
      ].join('\n');

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, fileContents } = makeContentCapturingSandbox({ existingAgentsMd: existing });
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      expect(fileContents['/home/agent/.codex/AGENTS.md']).toBeDefined();
      const agentsMdContent = fileContents['/home/agent/.codex/AGENTS.md'] ?? '';
      expect(agentsMdContent).toContain('# User instructions');
      expect(agentsMdContent).toContain('Keep this.');
      expect(agentsMdContent).toContain('Keep this too.');
      expect(agentsMdContent).toContain('### lint');
      expect(agentsMdContent).not.toContain('old generated content');
      expect((agentsMdContent.match(/<!-- vanguard-skills:start -->/g) ?? [])).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes AGENTS.md under CODEX_HOME when it is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'lint'), { recursive: true });
      await writeFile(join(dir, 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint.\n---\n');

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, copies } = makeContentCapturingSandbox({ codexHome: '/custom/codex-home' });
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      expect(copies.some(([, s]) => s === '/custom/codex-home/AGENTS.md')).toBe(true);
      expect(copies.some(([, s]) => s === '/home/agent/.codex/AGENTS.md')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('neutralizes sentinel text in skill metadata before writing AGENTS.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'tricky'), { recursive: true });
      await writeFile(
        join(dir, 'tricky', 'SKILL.md'),
        [
          '---',
          'name: tricky',
          'description: "mentions <!-- vanguard-skills:end --> inside metadata"',
          '---',
          '# Body',
        ].join('\n'),
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, fileContents } = makeContentCapturingSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      expect(fileContents['/home/agent/.codex/AGENTS.md']).toBeDefined();
      const agentsMdContent = fileContents['/home/agent/.codex/AGENTS.md'] ?? '';
      expect((agentsMdContent.match(/<!-- vanguard-skills:end -->/g) ?? [])).toHaveLength(1);
      expect(agentsMdContent).toContain('[vanguard-skills:end]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: calling injectAll twice produces one skills block each time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'lint'), { recursive: true });
      await writeFile(join(dir, 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint.\n---\n');

      const agentsMdContents: string[] = [];
      const { sandbox } = makeSandbox({
        onCopyIn: async (h, s) => {
          if (s.endsWith('/AGENTS.md')) {
            agentsMdContents.push(await readFile(h, 'utf-8').catch(() => ''));
          }
        },
      });

      const registry = await skillRegistryFromDirectory(dir);
      await registry.injectAll(sandbox, '/home/agent', 'codex');
      await registry.injectAll(sandbox, '/home/agent', 'codex');

      expect(agentsMdContents).toHaveLength(2);
      for (const content of agentsMdContents) {
        const startCount = (content.match(/<!-- vanguard-skills:start -->/g) ?? []).length;
        expect(startCount).toBe(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SkillRegistry.injectAll — cursor branch', () => {
  it('writes one .mdc per skill with frontmatter and pointer body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'lint'), { recursive: true });
      await writeFile(
        join(dir, 'lint', 'SKILL.md'),
        '---\nname: lint\ndescription: Run the linter.\n---\n# Lint\n',
      );
      await mkdir(join(dir, 'withglobs'), { recursive: true });
      await writeFile(
        join(dir, 'withglobs', 'SKILL.md'),
        '---\nname: withglobs\ndescription: A skill with globs.\nglobs: src/**/*.ts\n---\n# WithGlobs\n',
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, copies, fileContents } = makeContentCapturingSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'cursor');

      const mdcContents = Object.fromEntries(Object.entries(fileContents).filter(([k]) => k.endsWith('.mdc')));

      // One .mdc per skill
      const mdcPaths = Object.keys(mdcContents).sort();
      expect(mdcPaths).toEqual([
        '/workspace/.cursor/rules/lint.mdc',
        '/workspace/.cursor/rules/withglobs.mdc',
      ]);

      // Body pointer but not the skill body text
      for (const content of Object.values(mdcContents)) {
        expect(content).toContain('.vanguard/skills/');
        expect(content).toContain('SKILL.md');
        expect(content).toContain('alwaysApply: false');
      }

      // description frontmatter
      expect(mdcContents['/workspace/.cursor/rules/lint.mdc']).toContain('description:');
      expect(mdcContents['/workspace/.cursor/rules/lint.mdc']).toContain('Run the linter.');

      // globs present when declared in SKILL.md
      expect(mdcContents['/workspace/.cursor/rules/withglobs.mdc']).toContain('globs:');
      expect(mdcContents['/workspace/.cursor/rules/withglobs.mdc']).toContain('src/**/*.ts');

      // globs absent for lint (not declared)
      expect(mdcContents['/workspace/.cursor/rules/lint.mdc']).not.toContain('globs:');

      // Skill bodies are also copied
      const bodyCopies = copies.filter(([, s]) => s.startsWith('/workspace/.vanguard/skills/'));
      expect(bodyCopies.map(([, s]) => s).sort()).toEqual([
        '/workspace/.vanguard/skills/lint',
        '/workspace/.vanguard/skills/withglobs',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('safely handles descriptions with shell metacharacters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'tricky'), { recursive: true });
      const desc = 'Run `npm test` and check $HOME; use "quotes" & backticks.';
      await writeFile(
        join(dir, 'tricky', 'SKILL.md'),
        `---\nname: tricky\ndescription: ${desc}\n---\n# Tricky\n`,
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, fileContents } = makeContentCapturingSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'cursor');

      // Description reached the .mdc file intact (written via temp file, not shell exec)
      const mdcContent = fileContents['/workspace/.cursor/rules/tricky.mdc'];
      expect(mdcContent).toBeDefined();
      expect(mdcContent).toContain('npm test');
      expect(mdcContent).toContain('$HOME');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('escapes newlines and quotes in generated Cursor YAML frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vg-skills-'));
    try {
      await mkdir(join(dir, 'quoted'), { recursive: true });
      await writeFile(
        join(dir, 'quoted', 'SKILL.md'),
        '---\nname: quoted\ndescription: "Line one\\nline two with \\"quotes\\""\n---\n# Quoted\n',
      );

      const registry = await skillRegistryFromDirectory(dir);
      const { sandbox, fileContents } = makeContentCapturingSandbox();
      await registry.injectAll(sandbox, '/home/agent', 'cursor');

      const mdcContent = fileContents['/workspace/.cursor/rules/quoted.mdc'];
      expect(mdcContent).toContain('description: "Line one\\nline two with \\"quotes\\""');
      expect(mdcContent).toContain('alwaysApply: false');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SkillRegistry.injectAll — cross-provider families', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vg-cross-'));
    await mkdir(join(dir, 'myskill'), { recursive: true });
    await writeFile(join(dir, 'myskill', 'SKILL.md'), '---\nname: myskill\ndescription: A skill.\n---\n# Body\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('claude-impl / codex-review: injects into both ~/.claude/skills and AGENTS.md', async () => {
    const registry = await skillRegistryFromDirectory(dir);
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent', 'claude-code', 'codex');

    const claudeTarget = copies.find(([, s]) => s === '/home/agent/.claude/skills/myskill');
    expect(claudeTarget).toBeDefined();

    const agentsMd = copies.find(([, s]) => s.endsWith('/AGENTS.md'));
    expect(agentsMd).toBeDefined();

    const bodyTarget = copies.find(([, s]) => s === '/workspace/.vanguard/skills/myskill');
    expect(bodyTarget).toBeDefined();
  });

  it('codex-impl / claude-review: injects into both AGENTS.md and ~/.claude/skills', async () => {
    const registry = await skillRegistryFromDirectory(dir);
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent', 'codex', 'claude-code');

    const agentsMd = copies.find(([, s]) => s.endsWith('/AGENTS.md'));
    expect(agentsMd).toBeDefined();

    const claudeTarget = copies.find(([, s]) => s === '/home/agent/.claude/skills/myskill');
    expect(claudeTarget).toBeDefined();
  });

  it('same-provider (claude/claude): injects only once into ~/.claude/skills', async () => {
    const registry = await skillRegistryFromDirectory(dir);
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent', 'claude-code', 'zai');

    const claudeCopies = copies.filter(([, s]) => s.startsWith('/home/agent/.claude/skills/'));
    // Both map to the same 'claude' family — should inject exactly once per skill
    expect(claudeCopies).toHaveLength(1);
  });

  it('same-provider (codex/codex): injects only one AGENTS.md', async () => {
    const registry = await skillRegistryFromDirectory(dir);
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent', 'codex', 'codex');

    const agentsMdCopies = copies.filter(([, s]) => s.endsWith('/AGENTS.md'));
    expect(agentsMdCopies).toHaveLength(1);
  });

  it('codex/cursor: injects both provider indexes but copies shared skill bodies once', async () => {
    const registry = await skillRegistryFromDirectory(dir);
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent', 'codex', 'cursor');

    expect(copies.some(([, s]) => s === '/home/agent/.codex/AGENTS.md')).toBe(true);
    expect(copies.some(([, s]) => s === '/workspace/.cursor/rules/myskill.mdc')).toBe(true);

    const bodyCopies = copies.filter(([, s]) => s === '/workspace/.vanguard/skills/myskill');
    expect(bodyCopies).toHaveLength(1);
  });
});

describe('parseSkillMeta', () => {
  it('parses inline name and description', () => {
    const content = '---\nname: my-skill\ndescription: A useful skill.\n---\n# Body\n';
    expect(parseSkillMeta(content, 'fallback')).toEqual({ name: 'my-skill', description: 'A useful skill.' });
  });

  it('parses folded scalar description (ponytail shape)', () => {
    const content = [
      '---',
      'name: ponytail',
      'description: >',
      '  Forces the laziest solution that actually works, simplest, shortest, most',
      '  minimal. Channels a senior dev.',
      'argument-hint: "[lite|full|ultra]"',
      '---',
      '# Ponytail',
    ].join('\n');
    const meta = parseSkillMeta(content, 'fallback');
    expect(meta.name).toBe('ponytail');
    expect(meta.description).toBe('Forces the laziest solution that actually works, simplest, shortest, most minimal. Channels a senior dev.');
  });

  it('parses globs when present', () => {
    const content = '---\nname: ts\ndescription: TypeScript helper.\nglobs: src/**/*.ts\n---\n';
    expect(parseSkillMeta(content, 'fallback')).toEqual({
      name: 'ts',
      description: 'TypeScript helper.',
      globs: 'src/**/*.ts',
    });
  });

  it('parses quoted inline scalars', () => {
    const content = '---\nname: "quoted-name"\ndescription: "Run tests: npm test"\nglobs: \'src/**/*.ts\'\n---\n';
    expect(parseSkillMeta(content, 'fallback')).toEqual({
      name: 'quoted-name',
      description: 'Run tests: npm test',
      globs: 'src/**/*.ts',
    });
  });

  it('omits globs when not declared', () => {
    const content = '---\nname: ts\ndescription: TypeScript helper.\n---\n';
    const meta = parseSkillMeta(content, 'fallback');
    expect(meta.globs).toBeUndefined();
  });

  it('falls back to id and empty description on missing frontmatter', () => {
    expect(parseSkillMeta('# No frontmatter here\n', 'my-id')).toEqual({ name: 'my-id', description: '' });
  });

  it('falls back gracefully on empty content', () => {
    expect(parseSkillMeta('', 'my-id')).toEqual({ name: 'my-id', description: '' });
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
    const { sandbox, copies } = makeSandbox();
    await registry.injectAll(sandbox, '/home/agent');
    const targets = copies.map(([, s]) => s).sort();
    expect(targets).toEqual(['/home/agent/.claude/skills/fmt', '/home/agent/.claude/skills/lint']);
    await rm(dir, { recursive: true, force: true });
  });
});
