import { test, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DocEditor } from './DocEditor.js';

afterEach(() => {
  document.documentElement.classList.remove('dark');
});

// Render-only smoke: CodeMirror 6 drives input through contenteditable + DOM measurement, which
// jsdom doesn't reproduce, so we do NOT simulate typing (feasibility #2). We assert it mounts.
test('mounts with a value without throwing', () => {
  render(<DocEditor value={'# Hello\n'} onChange={() => {}} />);
  expect(screen.getByTestId('doc-editor')).toBeInTheDocument();
});

test('mounts read-only without throwing', () => {
  render(<DocEditor value={'x'} onChange={() => {}} readOnly />);
  expect(screen.getByTestId('doc-editor')).toBeInTheDocument();
});

// theme-follows-app: the editor picks vscodeDark when <html> has the `dark` class and vscodeLight
// otherwise, and switches live (via a MutationObserver) without a remount. data-theme reflects the
// same signal that selects the CodeMirror theme, so asserting it proves the theme follows the app.
test('theme follows the app dark class, switching live', async () => {
  document.documentElement.classList.remove('dark');
  render(<DocEditor value={'# Hello\n'} onChange={() => {}} />);
  const editor = screen.getByTestId('doc-editor');
  expect(editor).toHaveAttribute('data-theme', 'light');

  await act(async () => {
    document.documentElement.classList.add('dark');
    // let the MutationObserver microtask run
    await Promise.resolve();
  });
  expect(editor).toHaveAttribute('data-theme', 'dark');

  await act(async () => {
    document.documentElement.classList.remove('dark');
    await Promise.resolve();
  });
  expect(editor).toHaveAttribute('data-theme', 'light');
});
