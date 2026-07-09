import { useState, type ReactNode } from 'react';
import { Button, Input } from 'chunks-ui';
import { writeAppConfig } from '../../ipc';
import { useAppConfig } from '../../hooks';
import { SOURCES } from '../../sources';
import { projectColor } from '../../color';
import type { AppConfig } from '../../vanguard-output';

const PROVIDERS = ['claude', 'codex', 'cursor', 'zai', 'openrouter', 'meridian'];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">
        {label}
        {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function Settings({ project }: { project: string }) {
  // Inspector is keyed by project, so this component remounts on project switch —
  // config loads once and `dirty`/`saved` start clean without a reset effect.
  const [cfg, setCfg] = useAppConfig(project);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty(true);
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    await writeAppConfig(project, cfg);
    setDirty(false);
    setSaved(true);
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Settings</h2>
        <code className="text-xs text-muted-foreground">.vanguard/app.json</code>
        <Button className="ml-auto" onClick={save} disabled={!dirty}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      <div className="space-y-4 rounded-lg border border-border p-5">
        <Field label="Repo path">
          <Input value={project} readOnly className="w-full" />
        </Field>
        {/* Not a <Field> (which is a <label>) — a label would forward clicks on the readout/reset to
            the color input, opening the OS picker unexpectedly. Plain div; the input carries its own label. */}
        <div className="space-y-1">
          <span className="text-sm">
            Project color
            <span className="ml-1 text-xs text-muted-foreground">— context accent (top bar + dashboard card)</span>
          </span>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={projectColor({ path: project, color: cfg.color })}
              onChange={(e) => set('color', e.target.value)}
              aria-label="Project color"
              className="size-9 shrink-0 cursor-pointer rounded border border-border bg-background"
            />
            <code className="text-sm tabular-nums">{projectColor({ path: project, color: cfg.color })}</code>
            <span className="text-xs text-muted-foreground">{cfg.color ? 'custom' : 'auto from path'}</span>
            {cfg.color && (
              <Button variant="text" color="secondary" className="ml-auto" onClick={() => set('color', undefined)}>
                Reset to auto
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Task Source">
            <Select value={cfg.source ?? ''} onChange={(v) => set('source', v || undefined)} options={SOURCES} />
          </Field>
          <Field label="Label filter">
            <Input
              value={cfg.label ?? ''}
              onChange={(e) => set('label', e.target.value || undefined)}
              className="w-full"
              placeholder="vanguard-ready"
            />
          </Field>
        </div>
        {cfg.source === 'linear' && (
          <Field label="Linear team key" hint="— selects the board's team (e.g. DEV)">
            <Input
              value={cfg.team ?? ''}
              onChange={(e) => set('team', e.target.value.toUpperCase() || undefined)}
              className="w-full"
              placeholder="DEV"
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="provider">
            <Select value={cfg.provider ?? ''} onChange={(v) => set('provider', v || undefined)} options={PROVIDERS} />
          </Field>
          <Field label="reviewProvider" hint="optional">
            <Select
              value={cfg.reviewProvider ?? ''}
              onChange={(v) => set('reviewProvider', v || undefined)}
              options={PROVIDERS}
            />
          </Field>
        </div>
        <Field label="Verify command override" hint="— the Proof of Work">
          <Input
            value={cfg.verifyCmd ?? ''}
            onChange={(e) => set('verifyCmd', e.target.value || undefined)}
            className="w-full font-mono text-xs"
            placeholder="pnpm typecheck && pnpm test"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Concurrency">
            <Input
              type="number"
              value={cfg.concurrency ?? ''}
              onChange={(e) => set('concurrency', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full"
            />
          </Field>
          <Field label="Budget cap per Run">
            <Input
              type="number"
              value={cfg.budgetUsd ?? ''}
              onChange={(e) => set('budgetUsd', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full"
              placeholder="2.50"
            />
          </Field>
        </div>
        <div className="rounded-md border-l-4 border-sky-500/50 bg-sky-500/5 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
            Credentials
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            LLM credentials are inherited from your environment / keychain and never stored by the app or sent
            over any API.
          </p>
        </div>
      </div>
    </div>
  );
}
