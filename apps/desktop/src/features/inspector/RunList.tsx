import { useMemo, useState } from 'react';
import { Table, Chip, Empty, Input, ScrollTable } from '@/ui';
import { Inbox, RefreshCw, Search } from 'lucide-react';
import { relTime } from '../../time';
import type { Spawn } from './LaunchPanel';
import type { ActiveRun, RunSummary } from '../../vanguard-output';

/** `2026-07-06T19:12:02.123Z` -> `2026-07-06 19:12`. */
function when(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

/** A launched CLI run's label: the taskId once the process logs it, else the command sans `vanguard `. */
function spawnLabel(s: Spawn): string {
  for (const line of s.lines) {
    const m = line.match(/"taskId":"([^"]+)"/);
    if (m?.[1] !== undefined) return m[1];
  }
  return s.command.replace(/^vanguard\s+/, '');
}

type Filter = 'all' | 'passed' | 'failed';

export function RunList({
  runs,
  active,
  spawns,
  onSelect,
  onOpenActive,
  onOpenSpawn,
}: {
  runs: RunSummary[];
  /** In-flight runs discovered from `.vanguard` state, rendered as running rows at the top. */
  active: ActiveRun[];
  /** Locally-launched CLI runs; the still-running ones render as rows above `active`. */
  spawns: Spawn[];
  onSelect: (r: RunSummary) => void;
  onOpenActive: (a: ActiveRun) => void;
  onOpenSpawn: (pid: number) => void;
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

  // Still-running local launches. Like active rows they have no verdict, so "all" filter only.
  const runningSpawns = useMemo(() => spawns.filter((s) => s.exit === undefined), [spawns]);
  const shownSpawns = useMemo(() => {
    if (filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return runningSpawns.filter((s) => !q || spawnLabel(s).toLowerCase().includes(q));
  }, [runningSpawns, query, filter]);

  // Running rows have no pass/fail verdict yet, so they only appear under the "all" filter.
  const shownActive = useMemo(() => {
    if (filter !== 'all') return [];
    const q = query.trim().toLowerCase();
    return active.filter((a) => !q || a.taskId.toLowerCase().includes(q));
  }, [active, query, filter]);

  if (runs.length === 0 && active.length === 0 && runningSpawns.length === 0) {
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
          {shown.length + shownActive.length + shownSpawns.length} /{' '}
          {runs.length + (filter === 'all' ? active.length + runningSpawns.length : 0)}
        </span>
      </div>

      {shown.length === 0 && shownActive.length === 0 && shownSpawns.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No runs match.</div>
      ) : (
        <ScrollTable>
        <Table.Root>
          <Table.Header className="sticky top-0 z-10 bg-muted">
            <Table.Row>
              <Table.Head>Task</Table.Head>
              <Table.Head>When</Table.Head>
              <Table.Head>Stages</Table.Head>
              <Table.Head className="text-right">Cost</Table.Head>
              <Table.Head>Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shownSpawns.map((s) => (
              <Table.Row
                key={`spawn:${s.pid}`}
                onClick={() => onOpenSpawn(s.pid)}
                className="cursor-pointer bg-primary/10"
              >
                <Table.Cell className="font-medium">{spawnLabel(s)}</Table.Cell>
                <Table.Cell className="tabular-nums text-muted-foreground">now</Table.Cell>
                <Table.Cell className="text-muted-foreground">—</Table.Cell>
                <Table.Cell className="text-right tabular-nums text-muted-foreground">—</Table.Cell>
                <Table.Cell>
                  {/* Non-verdict color (blue) so a running row isn't mistaken for a green "passed" one. */}
                  <Chip color="primary" variant="outlined">
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
                      in progress
                    </span>
                  </Chip>
                </Table.Cell>
              </Table.Row>
            ))}
            {shownActive.map((a) => (
              <Table.Row
                key={`active:${a.taskId}`}
                onClick={() => onOpenActive(a)}
                className="cursor-pointer bg-primary/10"
              >
                <Table.Cell className="font-medium">{a.taskId}</Table.Cell>
                <Table.Cell className="tabular-nums text-muted-foreground">{relTime(a.lastActivityMs)}</Table.Cell>
                <Table.Cell className="text-muted-foreground">—</Table.Cell>
                <Table.Cell className="text-right tabular-nums text-muted-foreground">—</Table.Cell>
                <Table.Cell>
                  {/* Non-verdict color (blue) so a running row isn't mistaken for a green "passed" one. */}
                  <Chip color="primary" variant="outlined">
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
                      running
                    </span>
                  </Chip>
                </Table.Cell>
              </Table.Row>
            ))}
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
        </ScrollTable>
      )}
    </div>
  );
}
