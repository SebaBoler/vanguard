export interface XmlPromptSections {
  role?: string;
  guidelines?: string;
  policy?: string;
  context?: string;
  tradeoffs?: string;
  /** Required: the concrete task instructions. */
  task: string;
}

function section(tag: string, body: string | undefined): string {
  if (body === undefined || body.trim() === '') return '';
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

/**
 * Build an XML-tagged prompt per the Anthropic prompting playbook. Sections are emitted in a
 * fixed order; empty sections are dropped; <task_instructions> is always present.
 */
export function buildXmlPrompt(sections: XmlPromptSections): string {
  return [
    section('role', sections.role),
    section('guidelines', sections.guidelines),
    section('policy', sections.policy),
    section('context', sections.context),
    section('tradeoffs', sections.tradeoffs),
    section('task_instructions', sections.task),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}
