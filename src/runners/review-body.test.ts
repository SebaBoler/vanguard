import { describe, expect, it } from 'vitest';
import { reviewRequestBody } from './review-body.js';

describe('reviewRequestBody', () => {
  it('starts with Closes <task.id> when auto-close is enabled', () => {
    const taskId = 'owner/repo#42';
    const body = reviewRequestBody(taskId, { closeIssueOnMerge: true });
    expect(body).toBe(`Closes ${taskId}\n\nAutomated implementation of ${taskId} by Vanguard.`);
  });

  it('omits auto-close syntax by default', () => {
    const body = reviewRequestBody('LIN-42');
    expect(body).toBe('Automated implementation of LIN-42 by Vanguard.');
  });
});
