import { describe, it, expect } from 'vitest';
import { taskToVariables } from './fetcher.js';

describe('taskToVariables', () => {
  it('maps a task to TITLE/DESCRIPTION/LABELS/SUBTASKS variables', () => {
    const vars = taskToVariables({
      id: 'LOBE-1',
      title: 'Fix',
      description: 'Body',
      labels: ['bug', 'p1'],
      children: [
        { id: 'LOBE-2', title: 'Sub one' },
        { id: 'LOBE-3', title: 'Sub two' },
      ],
    });
    expect(vars).toEqual({
      TITLE: 'Fix',
      DESCRIPTION: 'Body',
      LABELS: 'bug, p1',
      SUBTASKS: 'LOBE-2 Sub one\nLOBE-3 Sub two',
    });
  });

  it('leaves SUBTASKS empty when there are no children', () => {
    const vars = taskToVariables({ id: 'LOBE-1', title: 'Fix', description: 'Body', labels: [], children: [] });
    expect(vars.SUBTASKS).toBe('');
  });
});
