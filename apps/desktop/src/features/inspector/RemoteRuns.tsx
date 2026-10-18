import { useState } from 'react';
import { Button, Table, Chip, ScrollTable } from '@/ui';
import { Download } from 'lucide-react';
import { importRemoteRun, listRemoteRuns } from '../../ipc';
import { useAsync } from '../../hooks';
import type { RemoteImport, RemoteRun, RunSource, RunSummary } from '../../vanguard-output';

function when(ts: string): string {
  return ts.replace('T', ' ').slice(0, 16);
}

function StatusChip({ r }: { r: RemoteRun }) {
  if (r.status !== 'completed') {
    return <Chip color="warning" variant="outlined">{r.status.replace(/_/g, ' ')}</Chip>;
  }
  const ok = r.conclusion === 'success';
  return (
    <Chip color={ok ? 'success' : 'destructive'} variant="outlined">
      {r.conclusion || 'done'}
    </Chip>
  );
}

/** Per-row state of the record fetch; absent = not asked yet. */
type Records = { loading: true } | { error: string } | { data: RemoteImport };

export function RemoteRuns({
  project,
  onOpenRun,
}: {
  project: string;
  /** Open an imported record in the run inspector. The `source` names the CI run, never a root —
   * whichever backend imported it resolves that in `read_run`. */
  onOpenRun: (run: RunSummary, source: RunSource) => void;
}) {
  const { data: runs, error, loading } = useAsync(() => listRemoteRuns(project), [project]);
  const [records, setRecords] = useState<Record<number, Records>>({});

  const fetchRecords = async (id: number): Promise<void> => {
    setRecords((m) => ({ ...m, [id]: { loading: true } }));
    try {
      const data = await importRemoteRun(project, id);
      setRecords((m) => ({ ...m, [id]: { data } }));
    } catch (e) {
      setRecords((m) => ({ ...m, [id]: { error: String(e) } }));
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading remote runs…</div>;
  if (error) {
    return (
      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        No remote runs. {error}
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return <div className="text-sm text-muted-foreground">No CI runs found for this repo.</div>;
  }
  return (
    <ScrollTable>
    <Table.Root>
      <Table.Header className="sticky top-0 z-10 bg-muted">
        <Table.Row>
          <Table.Head>Workflow</Table.Head>
          <Table.Head>Title</Table.Head>
          <Table.Head>Branch</Table.Head>
          <Table.Head>When</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head>Records</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {runs.map((r) => {
          const rec = records[r.id];
          const cached = r.cached || (rec !== undefined && 'data' in rec);
          return [
            <Table.Row key={r.id}>
              <Table.Cell className="font-medium">{r.workflow}</Table.Cell>
              <Table.Cell className="max-w-xs truncate text-muted-foreground" title={r.title}>
                {r.title}
              </Table.Cell>
              <Table.Cell className="text-muted-foreground">{r.branch}</Table.Cell>
              <Table.Cell className="tabular-nums text-muted-foreground">{when(r.createdAt)}</Table.Cell>
              <Table.Cell>
                <StatusChip r={r} />
              </Table.Cell>
              <Table.Cell>
                <span className="flex items-center gap-2">
                  {cached && <Chip color="secondary" variant="outlined">cached</Chip>}
                  {!(rec !== undefined && 'data' in rec) && (
                    <Button
                      variant="text"
                      color="secondary"
                      loading={rec !== undefined && 'loading' in rec}
                      onClick={() => void fetchRecords(r.id)}
                      startIcon={<Download className="size-3.5" />}
                    >
                      {cached ? 'Open records' : 'Fetch records'}
                    </Button>
                  )}
                </span>
              </Table.Cell>
            </Table.Row>,
            // The fetched records expand under the run as a mini run list; a click opens the
            // same RunDetail (Overview / Diff / Transcript) a local run gets.
            rec !== undefined && 'data' in rec && (
              <Table.Row key={`${r.id}:records`} className="bg-muted/30">
                <Table.Cell colSpan={6}>
                  {rec.data.runs.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No run records in this artifact.</span>
                  ) : (
                    <ul className="divide-y divide-border text-sm">
                      {rec.data.runs.map((s) => (
                        <li key={`${s.taskId}:${s.timestamp}`}>
                          <button
                            type="button"
                            onClick={() => onOpenRun(s, { kind: 'ci', runId: rec.data.runId })}
                            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-left hover:bg-muted"
                          >
                            <span className="font-medium">{s.taskId}</span>
                            <span className="tabular-nums text-muted-foreground">{when(s.timestamp)}</span>
                            <span className="text-muted-foreground">{s.stages.join(', ')}</span>
                            <Chip color={s.anyFailed ? 'destructive' : 'success'} variant="outlined">
                              {s.anyFailed ? 'failed' : 'passed'}
                            </Chip>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Table.Cell>
              </Table.Row>
            ),
            rec !== undefined && 'error' in rec && (
              <Table.Row key={`${r.id}:error`}>
                <Table.Cell colSpan={6} className="text-xs text-destructive">
                  {rec.error}
                </Table.Cell>
              </Table.Row>
            ),
          ];
        })}
      </Table.Body>
    </Table.Root>
    </ScrollTable>
  );
}
