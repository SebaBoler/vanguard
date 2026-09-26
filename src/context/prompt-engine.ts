import type { IsolatedSandboxProvider } from '../sandbox/provider.js';

export interface RenderOptions {
  variables: Record<string, string>;
  sandbox: IsolatedSandboxProvider;
  execTimeoutMs?: number;
}

const CMD = /!`([^`]+)`/g;
const KEY = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/**
 * Expand a prompt template: first run each !`cmd` inside the sandbox and inline its
 * stdout, then substitute {{KEY}} placeholders. Command-expansion runs before key
 * substitution so a variable value can never inject a command.
 */
export async function renderPrompt(template: string, opts: RenderOptions): Promise<string> {
  const matches = [...template.matchAll(CMD)];
  const outputs = await Promise.all(
    matches.map(async (match) => {
      const command = match[1] ?? '';
      const res = await opts.sandbox.exec(command, { timeoutMs: opts.execTimeoutMs ?? 60_000 });
      return res.stdout.trimEnd();
    }),
  );
  // Function replacers are immune to `$`-substitution patterns in command stdout.
  let index = 0;
  let out = template.replace(CMD, () => outputs[index++] ?? '');
  out = out.replace(KEY, (_full, key: string) => opts.variables[key] ?? '');
  return out;
}

/**
 * runAgent input for a finished prompt that holds untrusted text (an MR, PR or issue body). Inlined into a
 * template, that text would have its !`cmd` run in the sandbox and its {{KEY}}s blanked; a variable value
 * is substituted after both passes and never rescanned, so the whole prompt goes in as one variable.
 */
export function literalPrompt(prompt: string): { promptTemplate: string; variables: Record<string, string> } {
  return { promptTemplate: '{{PROMPT}}', variables: { PROMPT: prompt } };
}
