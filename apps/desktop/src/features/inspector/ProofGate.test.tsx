import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProofGate } from './ProofGate';

test('renders FAIL and the output tail when proof failed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 1, passed: false, sha256: 'x', outputTail: '1 test failed' }}
    />,
  );
  expect(screen.getByText(/FAIL/)).toBeInTheDocument();
  expect(screen.getByText(/1 test failed/)).toBeInTheDocument();
});

test('renders PASS when proof passed', () => {
  render(
    <ProofGate
      proof={{ command: 'pnpm test', exitCode: 0, passed: true, sha256: 'x', outputTail: 'ok' }}
    />,
  );
  expect(screen.getByText(/PASS/)).toBeInTheDocument();
});

test('renders a skipped note when there is no proof', () => {
  render(<ProofGate />);
  expect(screen.getByText(/No proof/)).toBeInTheDocument();
});
