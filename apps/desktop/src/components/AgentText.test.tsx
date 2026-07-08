import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AgentText } from './AgentText';

test('renders a short tag as a chip', () => {
  render(<AgentText>{'<promise>COMPLETE</promise>'}</AgentText>);
  expect(screen.getByText(/promise: COMPLETE/)).toBeInTheDocument();
});

test('renders a multi-line tag as a callout with markdown', () => {
  render(<AgentText>{'<plan>\n## Step 1\nDo the thing\n</plan>'}</AgentText>);
  expect(screen.getByText('plan')).toBeInTheDocument();
  expect(screen.getByText('Step 1')).toBeInTheDocument();
});

test('renders a findings segment as a per-finding list', () => {
  const findings = [{ severity: 'high', kind: 'security', title: 'Path traversal', evidence: 'unchecked `path` param' }];
  render(<AgentText>{`<findings>${JSON.stringify(findings)}</findings>`}</AgentText>);
  expect(screen.getByText('high')).toBeInTheDocument();
  expect(screen.getByText('security')).toBeInTheDocument();
  expect(screen.getByText('Path traversal')).toBeInTheDocument();
});

test('renders "No findings." for an empty findings array', () => {
  render(<AgentText>{'<findings>[]</findings>'}</AgentText>);
  expect(screen.getByText('No findings.')).toBeInTheDocument();
});
