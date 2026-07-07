import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProofGate } from './ProofGate';

test('renders failed status and the output tail when proof failed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 1, passed: false, sha256: 'x', outputTail: '1 test failed' }}
    />,
  );
  expect(screen.getByText('failed')).toBeInTheDocument();
  expect(screen.getByText('1 test failed')).toBeInTheDocument();
});

test('renders passed status when proof passed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 0, passed: true, sha256: 'x', outputTail: 'ok' }}
    />,
  );
  expect(screen.getByText('passed')).toBeInTheDocument();
});

test('renders a skipped note when there is no proof', () => {
  render(<ProofGate />);
  expect(screen.getByText(/No proof/)).toBeInTheDocument();
});
