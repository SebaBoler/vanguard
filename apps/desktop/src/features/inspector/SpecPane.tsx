import { useEffect, useState } from 'react';
import { AgentText } from '../../components/AgentText';
import { fetchSpec } from '../../ipc';

export function SpecPane({ project, taskId }: { project: string; taskId: string }) {
  const [spec, setSpec] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSpec(project, taskId)
      .then((s) => {
        if (alive) setSpec(s);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [project, taskId]);

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
