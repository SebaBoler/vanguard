import { Table, Chip, Empty } from 'chunks-ui';
import { Inbox } from 'lucide-react';
import type { RunSummary } from '../../vanguard-output';

/** `2026-07-06T19:12:02.123Z` -> `2026-07-06 19:12`. */
function when(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

export function RunList({
  runs,
  onSelect,
}: {
  runs: RunSummary[];
  onSelect: (r: RunSummary) => void;
}) {
  if (runs.length === 0) {
    return (
      <Empty.Root>
        <Empty.Media>
          <Inbox />
        </Empty.Media>
        <Empty.Title>No runs found</Empty.Title>
        <Empty.Description>
          Point at a repo containing <code>.vanguard/runs</code> and hit Load.
        </Empty.Description>
      </Empty.Root>
    );
  }
  return (
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Task</Table.Head>
          <Table.Head>When</Table.Head>
          <Table.Head>Stages</Table.Head>
          <Table.Head className="text-right">Cost</Table.Head>
          <Table.Head>Status</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {runs.map((r) => (
          <Table.Row
            key={`${r.taskId}:${r.timestamp}`}
            onClick={() => onSelect(r)}
            className="cursor-pointer"
          >
            <Table.Cell className="font-medium">{r.taskId}</Table.Cell>
            <Table.Cell className="tabular-nums text-muted-foreground">{when(r.timestamp)}</Table.Cell>
            <Table.Cell className="text-muted-foreground">{r.stages.join(', ')}</Table.Cell>
            <Table.Cell className="text-right tabular-nums">${r.totalCostUsd.toFixed(2)}</Table.Cell>
            <Table.Cell>
              <Chip color={r.anyFailed ? 'destructive' : 'success'} variant="outlined">
                {r.anyFailed ? 'failed' : 'passed'}
              </Chip>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
