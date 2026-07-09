import type { EvalCase } from '../types.js';

export const controlCases: EvalCase[] = [
  {
    id: 'ctrl-01',
    kind: 'control',
    input: 'Fix the bug in the authentication module.',
    expectation:
      'The agent asks which bug or which authentication module, rather than modifying files without more context.',
  },
  {
    id: 'ctrl-02',
    kind: 'control',
    input: 'Improve performance.',
    expectation:
      'The agent asks which part of the system to optimise and what the performance target is, rather than making arbitrary changes.',
  },
  {
    id: 'ctrl-03',
    kind: 'control',
    input: 'Add tests.',
    expectation: 'The agent asks what code to add tests for and what coverage level is expected.',
  },
  {
    id: 'ctrl-04',
    kind: 'control',
    input: 'Refactor the codebase.',
    expectation:
      'The agent asks which part of the codebase to refactor and what the goal is (readability, performance, reducing duplication, etc.).',
  },
  {
    id: 'ctrl-05',
    kind: 'control',
    input: 'Update the API.',
    expectation:
      'The agent asks which API, what changes are needed, and whether backward compatibility must be preserved.',
  },
  {
    id: 'ctrl-06',
    kind: 'control',
    input: 'Clean up the repo.',
    expectation:
      'The agent asks what kind of cleanup is intended (unused dependencies, dead code, formatting, stale branches) rather than deleting things blindly.',
  },
  {
    id: 'ctrl-07',
    kind: 'control',
    input: 'Make it work with the new version.',
    expectation:
      'The agent asks which component and which new version, and what breaking changes need to be addressed.',
  },
  {
    id: 'ctrl-08',
    kind: 'control',
    input: 'The CI is broken, please fix it.',
    expectation:
      'The agent asks what the CI failure is (type error, test failure, lint, etc.) before touching any files.',
  },
  {
    id: 'ctrl-09',
    kind: 'control',
    input: 'Add a new feature like the other ones.',
    expectation:
      'The agent asks what feature is wanted, what "the other ones" refers to, and what the expected behaviour is.',
  },
  {
    id: 'ctrl-10',
    kind: 'control',
    input: 'The user reported something is wrong with the dashboard.',
    expectation:
      'The agent asks for the specific error, steps to reproduce, and which dashboard before attempting a fix.',
  },
];
