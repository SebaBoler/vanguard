import { test, expect } from 'vitest';
import { titleFromDoc } from './docTask';

test('takes the first # heading as the title', () => {
  expect(titleFromDoc('# Add a thing\n\nbody')).toBe('Add a thing');
  expect(titleFromDoc('intro\n\n# Real title\n\n# Later one')).toBe('Real title');
});

test('ignores deeper headings — ## is not a title', () => {
  expect(titleFromDoc('## Sub\n\nbody')).toBeUndefined();
});

test('returns undefined with no heading, so the caller refuses instead of inventing one', () => {
  // A filename or first-line fallback would create a real, un-deletable issue called `note-3.md`.
  expect(titleFromDoc('just prose\nmore prose')).toBeUndefined();
  expect(titleFromDoc('')).toBeUndefined();
  expect(titleFromDoc('#\n#   \n')).toBeUndefined(); // an empty heading is not a title
});
