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

test('ignores a # inside a fenced code block — that is a shell comment, not the title', () => {
  // Taking it would file a real, un-deletable issue named "install deps".
  expect(titleFromDoc('```sh\n# install deps\npnpm i\n```\n\n# Real Title\n')).toBe('Real Title');
  expect(titleFromDoc('```\n# only in code\n```\n')).toBeUndefined();
  expect(titleFromDoc('~~~\n# tilde fence\n~~~\n# After\n')).toBe('After');
});

test('strips the trailing hashes of a closed-ATX heading', () => {
  expect(titleFromDoc('# Title #\n')).toBe('Title');
  expect(titleFromDoc('# Title ###\n')).toBe('Title');
});
