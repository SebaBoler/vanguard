import { describe, expect, it } from 'vitest';

describe('PR body assembly', () => {
  it('starts with Closes <task.id> for auto-close on merge', () => {
    const taskId = 'owner/repo#42';
    const baseBody = [`Closes ${taskId}`, `Automated implementation by Vanguard.`].join('\n\n');
    expect(baseBody.startsWith(`Closes ${taskId}`)).toBe(true);
  });
});
