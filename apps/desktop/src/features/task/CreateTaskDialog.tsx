import { Button } from '@/ui';

/**
 * Confirmation for the app's first irreversible write.
 *
 * Creating a task is not undoable from inside the app, so the user sees exactly what will happen and to
 * WHERE before it happens: the transport, the title, and the body size. It deliberately does not offer
 * "create and run" — one irreversible action per button.
 */
export function CreateTaskDialog({
  source,
  title,
  bodyBytes,
  busy,
  onConfirm,
  onCancel,
}: {
  source: string;
  title: string;
  bodyBytes: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[28rem] rounded-lg border border-border bg-background p-4 shadow-lg">
        <h2 className="text-sm font-medium">Create a task on {source}?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This creates a real issue and <strong>cannot be undone from here</strong>. It does not start a run.
        </p>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Title</dt>
            <dd className="truncate font-medium">{title}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Body</dt>
            <dd className="tabular-nums text-muted-foreground">{bodyBytes} bytes</dd>
          </div>
        </dl>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="text" color="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={busy}>
            Create task
          </Button>
        </div>
      </div>
    </div>
  );
}
