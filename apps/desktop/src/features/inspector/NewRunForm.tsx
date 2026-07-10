import { useState } from 'react';
import { Button, Textarea } from '@/ui';
import { Play } from 'lucide-react';

const PRESETS: { label: string; cmd: string }[] = [
  { label: 'Run issue', cmd: 'vanguard run --github <issue> --provider zai --llm-proxy' },
  { label: 'Watch fleet', cmd: 'vanguard watch --github --concurrency 3 --provider zai --llm-proxy' },
  { label: 'Run (GitLab MR)', cmd: 'vanguard run --gitlab <issue> --provider zai --llm-proxy' },
];

export function NewRunForm({
  defaultCommand,
  onRun,
  onCancel,
}: {
  defaultCommand: string;
  onRun: (command: string) => void;
  onCancel: () => void;
}) {
  const [cmd, setCmd] = useState(defaultCommand);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Presets:</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => setCmd(p.cmd)}
            className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            {p.label}
          </button>
        ))}
      </div>
      <Textarea
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        rows={2}
        className="w-full font-mono text-xs"
        placeholder="vanguard run --github <issue> --provider zai --llm-proxy"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Runs in the project dir · inherits your shell env (credentials).</span>
        <div className="flex gap-2">
          <Button variant="text" color="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => cmd.trim() && onRun(cmd.trim())} startIcon={<Play className="size-4" />}>
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}
