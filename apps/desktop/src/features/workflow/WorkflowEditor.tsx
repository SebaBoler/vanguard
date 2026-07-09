import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input } from 'chunks-ui';
import { CodeBlock } from '../../components/CodeBlock';
import { readAppConfig, writeAppConfig } from '../../ipc';
import type { AppConfig } from '../../vanguard-output';

type BlockKey = 'repo' | 'source' | 'models' | 'concurrency' | 'proof' | 'budget';

const BLOCKS: { key: BlockKey; label: string; dot: string }[] = [
  { key: 'repo', label: 'Repo', dot: 'bg-sky-500' },
  { key: 'source', label: 'Task Source', dot: 'bg-violet-500' },
  { key: 'models', label: 'Models', dot: 'bg-fuchsia-500' },
  { key: 'concurrency', label: 'Concurrency', dot: 'bg-amber-500' },
  { key: 'proof', label: 'Proof of Work', dot: 'bg-success' },
  { key: 'budget', label: 'Budget', dot: 'bg-orange-500' },
];

function summary(key: BlockKey, c: AppConfig, project: string): string {
  switch (key) {
    case 'repo':
      return project.replace(/^.*\//, '~/…/') || project;
    case 'source':
      return `${c.source ?? '—'}${c.label ? ` · ${c.label}` : ''}`;
    case 'models':
      return `${c.provider ?? 'claude'} / ${c.reviewProvider ?? c.provider ?? 'claude'}`;
    case 'concurrency':
      return `${c.concurrency ?? 1} slots`;
    case 'proof':
      return c.verifyCmd ?? 'auto-detect';
    case 'budget':
      return c.budgetUsd != null ? `$${c.budgetUsd.toFixed(2)}` : '—';
  }
}

function toHcl(c: AppConfig, project: string): string {
  return [
    'workflow "vanguard" {',
    `  repo   = "${project}"`,
    `  source = "${c.source ?? ''}"`,
    `  label  = "${c.label ?? ''}"`,
    '',
    '  run {',
    `    provider        = "${c.provider ?? 'claude'}"`,
    `    review_provider = "${c.reviewProvider ?? c.provider ?? 'claude'}"`,
    '  }',
    '',
    `  fleet  { concurrency = ${c.concurrency ?? 1} }`,
    `  verify { command = "${c.verifyCmd ?? ''}" }`,
    `  budget { max_usd = ${c.budgetUsd ?? 0} }`,
    '}',
  ].join('\n');
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function WorkflowEditor({ project, name }: { project: string; name: string }) {
  const [cfg, setCfg] = useState<AppConfig>({});
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<BlockKey>('source');
  const [tab, setTab] = useState<'canvas' | 'source'>('canvas');

  useEffect(() => {
    readAppConfig(project)
      .then((c) => {
        setCfg(c);
        setDirty(false);
      })
      .catch(() => {});
  }, [project]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    await writeAppConfig(project, cfg);
    setDirty(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-3">
        <h2 className="font-semibold">Workflow</h2>
        <code className="text-xs text-muted-foreground">{name}.vanguard.hcl</code>
        {dirty && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">unsaved</span>}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded border border-border p-0.5 text-xs">
            {(['canvas', 'source'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-2 py-0.5 capitalize ${tab === t ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <Button onClick={save} disabled={!dirty}>Save</Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
      {tab === 'source' ? (
        <CodeBlock code={toHcl(cfg, project)} lang="hcl" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[140px_1fr_300px]">
          <div className="rounded-lg border border-border p-2">
            <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Blocks</div>
            <div className="space-y-1">
              {BLOCKS.map((b) => (
                <div key={b.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                  <span className={`size-2 rounded-full ${b.dot}`} />
                  {b.label}
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-[24rem] overflow-x-auto rounded-lg border border-border bg-[radial-gradient(circle,theme(colors.border)_1px,transparent_1px)] [background-size:16px_16px] p-6">
            <div className="flex items-start gap-2">
              {BLOCKS.map((b, i) => (
                <div key={b.key} className="flex items-start gap-2">
                  <button
                    onClick={() => setSelected(b.key)}
                    className={`w-40 rounded-md border bg-background p-3 text-left transition-colors ${
                      selected === b.key ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className={`size-2 rounded-full ${b.dot}`} />
                      {b.label}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{summary(b.key, cfg, project)}</div>
                  </button>
                  {i < BLOCKS.length - 1 && <span className="mt-6 text-muted-foreground">→</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Inspector — {BLOCKS.find((b) => b.key === selected)?.label}
            </div>
            <div className="space-y-3">
              {selected === 'repo' && (
                <Field label="Repo path">
                  <Input value={project} readOnly className="w-full" />
                </Field>
              )}
              {selected === 'source' && (
                <>
                  <Field label="Source">
                    <Input value={cfg.source ?? ''} onChange={(e) => set('source', e.target.value || undefined)} className="w-full" placeholder="github / gitlab / linear" />
                  </Field>
                  <Field label="Label filter">
                    <Input value={cfg.label ?? ''} onChange={(e) => set('label', e.target.value || undefined)} className="w-full" />
                  </Field>
                </>
              )}
              {selected === 'models' && (
                <>
                  <Field label="Provider">
                    <Input value={cfg.provider ?? ''} onChange={(e) => set('provider', e.target.value || undefined)} className="w-full" placeholder="claude" />
                  </Field>
                  <Field label="Review provider">
                    <Input value={cfg.reviewProvider ?? ''} onChange={(e) => set('reviewProvider', e.target.value || undefined)} className="w-full" />
                  </Field>
                </>
              )}
              {selected === 'concurrency' && (
                <Field label="Concurrency">
                  <Input type="number" value={cfg.concurrency ?? ''} onChange={(e) => set('concurrency', e.target.value ? Number(e.target.value) : undefined)} className="w-full" />
                </Field>
              )}
              {selected === 'proof' && (
                <Field label="Command">
                  <Input value={cfg.verifyCmd ?? ''} onChange={(e) => set('verifyCmd', e.target.value || undefined)} className="w-full font-mono text-xs" placeholder="bun test apps/backend" />
                </Field>
              )}
              {selected === 'budget' && (
                <Field label="Budget cap per Run ($)">
                  <Input type="number" value={cfg.budgetUsd ?? ''} onChange={(e) => set('budgetUsd', e.target.value ? Number(e.target.value) : undefined)} className="w-full" />
                </Field>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
