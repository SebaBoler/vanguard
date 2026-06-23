import { readdir, stat, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VanguardError } from '../core/errors.js';
import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

const SKILLS_DIR = '/workspace/.vanguard/skills';
const CURSOR_RULES_DIR = '/workspace/.cursor/rules';
const AGENTS_MD_SENTINEL_START = '<!-- vanguard-skills:start -->';
const AGENTS_MD_SENTINEL_END = '<!-- vanguard-skills:end -->';

interface SkillMeta {
  name: string;
  description: string;
  globs?: string;
}

type SkillEntry = { id: string; hostPath: string; meta: SkillMeta };

function providerFamily(agentName: string | undefined): 'claude' | 'codex' | 'cursor' {
  if (agentName === 'codex') return 'codex';
  if (agentName === 'cursor') return 'cursor';
  return 'claude';
}

/**
 * Parse the YAML frontmatter from a SKILL.md content string.
 * Handles the small subset used by skill files: inline scalars and folded scalars.
 * Falls back to fallbackId/empty on missing or malformed frontmatter.
 */
export function parseSkillMeta(content: string, fallbackId: string): SkillMeta {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\n---/);
  if (!fenceMatch) return { name: fallbackId, description: '' };

  const fm = fenceMatch[1] ?? '';
  const lines = fm.split('\n');

  let name = fallbackId;
  let description = '';
  let globs: string | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const keyMatch = line.match(/^([\w][\w-]*):\s*(.*)/);
    if (keyMatch) {
      const key = keyMatch[1] ?? '';
      const value = (keyMatch[2] ?? '').trim();

      if (/^>[+-]?$/.test(value)) {
        // Folded scalar: collect indented continuation lines into one space-joined string.
        const parts: string[] = [];
        i++;
        while (i < lines.length) {
          const next = lines[i] ?? '';
          if (!next.startsWith(' ') && next.trim() !== '') break;
          const trimmed = next.trim();
          if (trimmed) parts.push(trimmed);
          i++;
        }
        const folded = parts.join(' ');
        if (key === 'name') name = folded || fallbackId;
        else if (key === 'description') description = folded;
        else if (key === 'globs') globs = folded || undefined;
        continue;
      }

      const scalar = parseInlineYamlScalar(value);
      if (key === 'name') name = scalar || fallbackId;
      else if (key === 'description') description = scalar;
      else if (key === 'globs') globs = scalar || undefined;
    }
    i++;
  }

  return globs !== undefined ? { name, description, globs } : { name, description };
}

function parseInlineYamlScalar(value: string): string {
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function readSkillMeta(hostPath: string, fallbackId: string): Promise<SkillMeta> {
  try {
    const content = await readFile(join(hostPath, 'SKILL.md'), 'utf-8');
    return parseSkillMeta(content, fallbackId);
  } catch {
    return { name: fallbackId, description: '' };
  }
}

function stripVanguardSkillsBlock(content: string): string {
  return content
    .replace(/<!-- vanguard-skills:start -->[\s\S]*?<!-- vanguard-skills:end -->\n*/g, '')
    .trimEnd();
}

function agentIndexText(s: string): string {
  return s
    .replaceAll(AGENTS_MD_SENTINEL_START, '[vanguard-skills:start]')
    .replaceAll(AGENTS_MD_SENTINEL_END, '[vanguard-skills:end]')
    .replace(/\r/g, '');
}

function buildCodexAgentsBlock(entries: Array<{ id: string; meta: SkillMeta }>): string {
  const skillsBlock = entries
    .map(({ id, meta }) =>
      [
        `### ${agentIndexText(meta.name).replace(/\n+/g, ' ')}`,
        agentIndexText(meta.description),
        '',
        `See .vanguard/skills/${id}/SKILL.md for full instructions.`,
      ].join('\n'),
    )
    .join('\n\n');

  return [
    AGENTS_MD_SENTINEL_START,
    '## Vanguard Skills',
    '',
    `The following skills are available. Read a skill's SKILL.md for full instructions when it is relevant to the task.`,
    '',
    skillsBlock,
    '',
    AGENTS_MD_SENTINEL_END,
  ].join('\n');
}

function mergeCodexAgentsMd(existing: string, vanguardBlock: string): string {
  const preserved = stripVanguardSkillsBlock(existing);
  return [preserved, vanguardBlock].filter(Boolean).join('\n\n') + '\n';
}

async function resolveCodexHome(sandbox: IsolatedSandboxProvider, fallbackHome: string): Promise<string> {
  const res = await sandbox.exec('printf %s "${CODEX_HOME:-$HOME/.codex}"');
  const codexHome = res.stdout.trim();
  return codexHome === '' ? `${fallbackHome}/.codex` : codexHome;
}

/** Resolve metadata and copy all skill bodies into the sandbox's skills dir. */
async function prepareSkillEntries(skills: Record<string, string>, sandbox: IsolatedSandboxProvider): Promise<SkillEntry[]> {
  const entries = await Promise.all(
    Object.entries(skills).map(async ([id, hostPath]) => ({ id, hostPath, meta: await readSkillMeta(hostPath, id) })),
  );
  await sandbox.exec(`mkdir -p ${SKILLS_DIR}`);
  await Promise.all(entries.map(({ id, hostPath }) => sandbox.copyIn(hostPath, `${SKILLS_DIR}/${id}`)));
  return entries;
}

/** Inject all skills for the claude/zai family: copy each into ~/.claude/skills/<id>. */
async function injectClaude(skills: Record<string, string>, sandbox: IsolatedSandboxProvider, home: string): Promise<void> {
  await Promise.all(
    Object.entries(skills).map(([id, hostPath]) => sandbox.copyIn(hostPath, `${home}/.claude/skills/${id}`)),
  );
}

/**
 * Inject skills for Codex: copy bodies to /workspace/.vanguard/skills/<id> and write a
 * pointer-only index to $CODEX_HOME/AGENTS.md (no full bodies in always-on context).
 *
 * Approach (a) rationale: AGENTS.md is always-on context prepended to every Codex turn. Dumping
 * full skill bodies inflates every request. Instead we write name + description + a pointer to the
 * readable SKILL.md; Codex can open the file when the description matches the task.
 *
 * Location: $CODEX_HOME/AGENTS.md (or $HOME/.codex/AGENTS.md by default), so the file is never
 * copied back into the PR diff.
 */
async function injectCodex(skills: Record<string, string>, sandbox: IsolatedSandboxProvider, home: string): Promise<void> {
  if (Object.keys(skills).length === 0) return;

  const entries = await prepareSkillEntries(skills, sandbox);

  const [codexHome, existingAgents] = await Promise.all([
    resolveCodexHome(sandbox, home),
    sandbox.exec('cat "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" 2>/dev/null || true'),
  ]);
  const agentsMd = mergeCodexAgentsMd(existingAgents.stdout, buildCodexAgentsBlock(entries));

  // Write via host temp + copyIn to avoid shell-quoting issues with model-authored descriptions.
  const tmpDir = await mkdtemp(join(tmpdir(), 'vg-codex-'));
  try {
    const tmpFile = join(tmpDir, 'AGENTS.md');
    await Promise.all([
      writeFile(tmpFile, agentsMd, 'utf-8'),
      sandbox.exec('mkdir -p "${CODEX_HOME:-$HOME/.codex}"'),
    ]);
    await sandbox.copyIn(tmpFile, `${codexHome}/AGENTS.md`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Inject skills for Cursor: copy bodies to /workspace/.vanguard/skills/<id> and write one
 * .cursor/rules/<id>.mdc per skill with frontmatter (description, optional globs,
 * alwaysApply: false). Body is a pointer to the readable SKILL.md so auto-attached context stays
 * small (parallel to the codex approach-a choice).
 */
async function injectCursor(skills: Record<string, string>, sandbox: IsolatedSandboxProvider): Promise<void> {
  if (Object.keys(skills).length === 0) return;

  const entries = await prepareSkillEntries(skills, sandbox);
  await sandbox.exec(`mkdir -p "${CURSOR_RULES_DIR}"`);

  const tmpDir = await mkdtemp(join(tmpdir(), 'vg-cursor-'));
  try {
    await Promise.all(
      entries.map(async ({ id, meta }) => {
        const frontmatterLines = [
          '---',
          `description: ${JSON.stringify(meta.description)}`,
          ...(meta.globs !== undefined ? [`globs: ${JSON.stringify(meta.globs)}`] : []),
          'alwaysApply: false',
          '---',
        ];
        const mdc = `${frontmatterLines.join('\n')}\nSee .vanguard/skills/${id}/SKILL.md for full instructions.\n`;
        const tmpFile = join(tmpDir, `${id}.mdc`);
        await writeFile(tmpFile, mdc, 'utf-8');
        await sandbox.copyIn(tmpFile, `${CURSOR_RULES_DIR}/${id}.mdc`);
      }),
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

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
   * Inject ALL registered skills in a provider-aware way:
   * - claude-code / zai / default → ~/.claude/skills/<id> (auto-discovered by the claude CLI)
   * - codex → $CODEX_HOME/AGENTS.md (pointer index) + .vanguard/skills/<id> bodies
   * - cursor → .cursor/rules/<id>.mdc per skill + .vanguard/skills/<id> bodies
   */
  async injectAll(sandbox: IsolatedSandboxProvider, home: string, agentName?: string): Promise<void> {
    const family = providerFamily(agentName);
    if (family === 'codex') {
      await injectCodex(this.skills, sandbox, home);
    } else if (family === 'cursor') {
      await injectCursor(this.skills, sandbox);
    } else {
      await injectClaude(this.skills, sandbox, home);
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
