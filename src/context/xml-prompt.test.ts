import { describe, it, expect } from 'vitest';
import { buildXmlPrompt } from './xml-prompt.js';

describe('buildXmlPrompt', () => {
  it('orders sections and wraps each in its tag', () => {
    expect(buildXmlPrompt({ role: 'R', task: 'do it' })).toBe(
      '<role>\nR\n</role>\n\n<task_instructions>\ndo it\n</task_instructions>',
    );
  });

  it('omits empty sections but always includes the task', () => {
    expect(buildXmlPrompt({ task: 'only task', context: '   ' })).toBe(
      '<task_instructions>\nonly task\n</task_instructions>',
    );
  });
});
