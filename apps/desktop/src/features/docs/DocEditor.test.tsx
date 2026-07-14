import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocEditor } from './DocEditor.js';

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
