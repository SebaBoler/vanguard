import { useMemo, useState } from 'react';
import { Table, Chip, Empty, Input } from 'chunks-ui';
import { Inbox, Search } from 'lucide-react';
import type { RunSummary } from '../../vanguard-output';

/** `2026-07-06T19:12:02.123Z` -> `2026-07-06 19:12`. */
function when(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

type Filter = 'all' | 'passed' | 'failed';

export function RunList({
  runs,
  onSelect,
}: {
  runs: RunSummary[];
  onSelect: (r: RunSummary) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (q && !r.taskId.toLowerCase().includes(q)) return false;
      if (filter === 'passed' && r.anyFailed) return false;
      if (filter === 'failed' && !r.anyFailed) return false;
      return true;
    });
  }, [runs, query, filter]);

  if (runs.length === 0) {
    return (
      <Empty.Root>
        <Empty.Media>
          <Inbox />
        </Empty.Media>
        <Empty.Title>No runs found</Empty.Title>
        <Empty.Description>
          This repo has no <code>.vanguard/runs</code> yet.
        </Empty.Description>
      </Empty.Root>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          startAdornment={<Search className="size-4" />}
          placeholder="Filter by task…"
          className="w-56"
        />
        <div className="flex gap-1">
          {(['all', 'passed', 'failed'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 text-xs capitalize transition-colors ${
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {shown.length} / {runs.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No runs match.</div>
      ) : (
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
            {shown.map((r) => (
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
      )}
    </div>
  );
}
