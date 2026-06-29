import type { EvalCase } from '../types.js';

export const edgeCases: EvalCase[] = [
  {
    id: 'edge-01',
    kind: 'edge',
    input: '',
    expectation:
      'An empty input is handled gracefully: the agent asks what task is needed rather than hallucinating one.',
  },
  {
    id: 'edge-02',
    kind: 'edge',
    input:
      'Add a TypeScript type for a value that can be any of: string, number, boolean, null, undefined, or a nested object of the same type.',
    expectation:
      'The agent produces a correct recursive TypeScript type definition without introducing any holes.',
  },
  {
    id: 'edge-03',
    kind: 'edge',
    input: 'Move the login page to /auth but keep /login working for backward compatibility.',
    expectation:
      'The agent implements both the new route and a backward-compatible redirect, not just one of the two.',
  },
  {
    id: 'edge-04',
    kind: 'edge',
    input: 'Remove the feature flag and enable the feature for everyone, but only in production.',
    expectation:
      'The agent recognises the contradiction (remove flag vs. production-only) and either asks for clarification or proposes a principled resolution.',
  },
  {
    id: 'edge-05',
    kind: 'edge',
    input: 'Write a function that is both pure (no side effects) and caches its results in a global map.',
    expectation:
      'The agent flags the contradiction between "pure" and "global cache" and proposes a principled resolution or asks for clarification.',
  },
  {
    id: 'edge-06',
    kind: 'edge',
    input: 'The task list has 0 items. Display an appropriate empty state.',
    expectation:
      'The agent implements a meaningful empty-state UI, not an empty component or a bare "no items" string.',
  },
  {
    id: 'edge-07',
    kind: 'edge',
    input: 'Optimise the database query that takes 0 ms to complete.',
    expectation:
      'The agent recognises there is nothing to optimise and says so, rather than making unnecessary changes.',
  },
  {
    id: 'edge-08',
    kind: 'edge',
    input:
      'Implement a pagination component that shows pages 1 through 1 when there is exactly one page of results.',
    expectation:
      'The agent handles the single-page edge case by hiding or disabling pagination controls appropriately.',
  },
  {
    id: 'edge-09',
    kind: 'edge',
    input:
      'Sort this list of strings: ["banana", "apple", "cherry"]. Use descending order and ascending order.',
    expectation:
      'The agent recognises the contradictory sort instructions and asks for clarification or proposes showing both orderings.',
  },
  {
    id: 'edge-10',
    kind: 'edge',
    input: 'Add logging to every function in the codebase.',
    expectation:
      'The agent flags this as an over-broad request that would degrade performance and proposes a targeted approach (specific modules, entry points, or error paths only).',
  },
];
