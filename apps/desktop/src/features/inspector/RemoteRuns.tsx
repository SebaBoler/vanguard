import { Table, Chip } from 'chunks-ui';
import { listRemoteRuns } from '../../ipc';
import { useAsync } from '../../hooks';
import { ScrollTable } from '../../components/ScrollTable';
import type { RemoteRun } from '../../vanguard-output';

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

export function RemoteRuns({ project }: { project: string }) {
  const { data: runs, error, loading } = useAsync(() => listRemoteRuns(project), [project]);

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
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {runs.map((r) => (
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
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
    </ScrollTable>
  );
}
