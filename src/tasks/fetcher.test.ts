import { describe, it, expect } from 'vitest';
import { taskToVariables } from './fetcher.js';

describe('taskToVariables', () => {
  it('maps a task to TITLE/DESCRIPTION/LABELS variables', () => {
    const vars = taskToVariables({ id: 'LOBE-1', title: 'Fix', description: 'Body', labels: ['bug', 'p1'] });
    expect(vars).toEqual({ TITLE: 'Fix', DESCRIPTION: 'Body', LABELS: 'bug, p1' });
  });
});
