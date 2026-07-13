import { useState } from 'react';
import { Button, Collapsible, Input } from '@/ui';
import { Play } from 'lucide-react';
import { EnumSelect } from './EnumSelect';
import type { Capabilities, CreateRunParams } from '../../ipc';

export function NewRunForm({
  capabilities,
  project,
  onRun,
  onCancel,
}: {
  capabilities: Capabilities;
  project: string;
  onRun: (params: CreateRunParams) => void;
  onCancel: () => void;
}) {
  const [issueRef, setIssueRef] = useState('');
  const [transport, setTransport] = useState(capabilities.transports[0] ?? 'github');
  const [provider, setProvider] = useState(capabilities.defaults.provider);
  const [flow, setFlow] = useState(capabilities.flows[0]?.name ?? 'default');
  const [maxTurns, setMaxTurns] = useState(String(capabilities.defaults.maxTurns));
  const [baseBranch, setBaseBranch] = useState(capabilities.defaults.baseBranch);

  const maxTurnsNum = Number(maxTurns);
  // Mirrors validateCreateRun (sidecar): non-blank issueRef, positive-integer maxTurns, non-blank base.
  const valid = issueRef.trim() !== '' && Number.isInteger(maxTurnsNum) && maxTurnsNum > 0 && baseBranch.trim() !== '';

  const params: CreateRunParams = {
    issueRef: issueRef.trim(),
    repoPath: project,
    transport,
    provider,
    flow,
    maxTurns: maxTurnsNum,
    baseBranch: baseBranch.trim(),
  };
  const preview = `vanguard run --${transport} ${issueRef || '<issue>'} --provider ${provider}${flow === 'plan' ? ' --plan' : ''} --max-turns ${maxTurns}`;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={issueRef} onChange={(e) => setIssueRef(e.target.value)} placeholder="issue ref (e.g. 322)" className="w-40" />
        <EnumSelect value={transport} onValueChange={setTransport} options={capabilities.transports.map((t) => ({ value: t, label: t }))} />
        <EnumSelect value={provider} onValueChange={setProvider} options={capabilities.providers.map((p) => ({ value: p, label: p }))} />
        <EnumSelect value={flow} onValueChange={setFlow} options={capabilities.flows.map((f) => ({ value: f.name, label: f.label }))} />
      </div>

      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs text-muted-foreground hover:text-foreground">Advanced</Collapsible.Trigger>
        <Collapsible.Panel className="flex flex-wrap items-center gap-3 pt-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            max-turns
            <Input value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} className="w-16" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            base
            <Input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="w-28" />
          </label>
        </Collapsible.Panel>
      </Collapsible.Root>

      <Collapsible.Root>
        <Collapsible.Trigger className="text-xs text-muted-foreground hover:text-foreground">≈ command</Collapsible.Trigger>
        <Collapsible.Panel className="pt-1">
          <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground" title={preview}>
            {preview}
          </code>
          <span className="text-[10px] text-muted-foreground">approximate — the run uses the structured fields, not this string</span>
        </Collapsible.Panel>
      </Collapsible.Root>

      <div className="flex items-center justify-end gap-2">
        <Button variant="text" color="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!valid} onClick={() => valid && onRun(params)} startIcon={<Play className="size-4" />}>
          Run
        </Button>
      </div>
    </div>
  );
}
