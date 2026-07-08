import { AgentText } from '../../components/AgentText';
import { fetchSpec } from '../../ipc';
import { useAsync } from '../../hooks';

export function SpecPane({ project, taskId }: { project: string; taskId: string }) {
  const { data: spec, error, loading } = useAsync(() => fetchSpec(project, taskId), [project, taskId]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading spec…</div>;
  if (error) {
    return (
      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Couldn&apos;t load the source spec. {error}
      </div>
    );
  }
  if (!spec) return <div className="text-sm text-muted-foreground">No spec.</div>;
  return <AgentText>{spec}</AgentText>;
}
