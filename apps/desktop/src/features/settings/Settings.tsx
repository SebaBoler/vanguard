import { useState, type ReactNode } from 'react';
import { Button, Input } from '@/ui';
import { writeAppConfig } from '../../ipc';
import { useAppConfig } from '../../hooks';
import { SOURCES } from '../../sources';
import { projectColor } from '../../color';
import { customProviderRowError, PROVIDERS } from './customProviders';
import type { AppConfig } from '../../vanguard-output';

type CustomProviderRow = NonNullable<AppConfig['customProviders']>[number];

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
  danglingLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  /** Render a stored value missing from options as a flagged entry so display matches storage. */
  danglingLabel?: (v: string) => string;
}) {
  const dangling = value !== '' && !options.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded border border-border bg-background px-2 text-sm"
    >
      <option value="">—</option>
      {dangling && (
        <option value={value}>{danglingLabel ? danglingLabel(value) : value}</option>
      )}
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
  const [cfg, setCfg, cfgStatus] = useAppConfig(project);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]): void => {
    setCfg((c) => ({ ...c, [k]: v }));
    setDirty(true);
    setSaved(false);
  };

  const customs: CustomProviderRow[] = cfg.customProviders ?? [];
  const customErrors = customs.map((row, i) => customProviderRowError(row, i, customs));
  const customsValid = customErrors.every((e) => e === undefined);
  const healthyCustomNames = customs.filter((_, i) => customErrors[i] === undefined).map((r) => r.name);
  const providerOptions = [...PROVIDERS, ...healthyCustomNames];

  const setCustoms = (rows: CustomProviderRow[]): void => set('customProviders', rows.length > 0 ? rows : undefined);
  const setRow = (i: number, patch: Partial<CustomProviderRow>): void =>
    setCustoms(customs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Save gating (S6 §8 guards): before the config read resolves, a save would write the {} seed
  // over the file; after a FAILED read ('error' = the file exists but does not parse), a save
  // would replace the user's hand-edited JSON with defaults. Invalid custom rows also block.
  const savable = dirty && cfgStatus === 'ready' && customsValid;

  const save = async (): Promise<void> => {
    await writeAppConfig(project, cfg);
    setDirty(false);
    setSaved(true);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">Settings</h2>
        <code className="text-xs text-muted-foreground">.vanguard/app.json</code>
        <Button className="ml-auto" onClick={save} disabled={!savable}>
          {saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      {cfgStatus === 'error' && (
        <div className="rounded-md border-l-4 border-rose-500/60 bg-rose-500/5 p-3 text-sm text-muted-foreground">
          <span className="font-semibold text-rose-600 dark:text-rose-400">.vanguard/app.json is unreadable</span> — fix
          its JSON by hand before editing here; saving now would replace the whole file.
        </div>
      )}

      {/* The form renders only once the read resolves: fields shown from the {} seed would accept
          edits that the resolving setCfg then silently discards — while dirty stays true, so the
          next Save persists the loaded config WITHOUT the user's edit (review #341 r3 obs 1; the
          local-file read resolves in ms, so the blank frame is invisible). */}
      {cfgStatus === 'loading' ? (
        <div className="rounded-lg border border-border p-5 text-sm text-muted-foreground">Loading…</div>
      ) : (
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
            {/* Built-ins + this repo's healthy customs; a stored name that no longer resolves shows
                flagged instead of silently rendering the em-dash while the value persists. */}
            <Select
              value={cfg.provider ?? ''}
              onChange={(v) => set('provider', v || undefined)}
              options={providerOptions}
              danglingLabel={(v) => `${v} (not configured)`}
            />
          </Field>
          <Field label="reviewProvider" hint="optional — built-ins only (customs never review)">
            <Select
              value={cfg.reviewProvider ?? ''}
              onChange={(v) => set('reviewProvider', v || undefined)}
              options={PROVIDERS}
              danglingLabel={(v) => `${v} (not supported)`}
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
        <Field label="Doc chat model" hint="— the Docs editor chat (uses your Claude auth from the environment)">
          <Input
            value={cfg.chatModel ?? ''}
            onChange={(e) => set('chatModel', e.target.value || undefined)}
            className="w-full font-mono text-xs"
            placeholder="claude-sonnet-5"
          />
        </Field>

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Custom providers</span>
            <span className="text-xs text-muted-foreground">
              — Anthropic-compatible endpoints run with <code>--provider &lt;name&gt;</code> (S6)
            </span>
            <Button
              variant="text"
              color="secondary"
              className="ml-auto"
              onClick={() => setCustoms([...customs, { name: '', baseUrl: '', keyEnv: '' }])}
            >
              Add
            </Button>
          </div>
          {customs.map((row, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border p-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="name" hint="lowercase, e.g. my-proxy">
                  <Input value={row.name} onChange={(e) => setRow(i, { name: e.target.value })} className="w-full font-mono text-xs" />
                </Field>
                <Field label="key env var" hint="the variable NAME — never the key itself">
                  <Input
                    value={row.keyEnv}
                    onChange={(e) => setRow(i, { keyEnv: e.target.value })}
                    className="w-full font-mono text-xs"
                    placeholder="MY_PROXY_API_KEY"
                  />
                </Field>
              </div>
              <Field label="base URL" hint="Anthropic-Messages-compatible endpoint">
                <Input
                  value={row.baseUrl}
                  onChange={(e) => setRow(i, { baseUrl: e.target.value })}
                  className="w-full font-mono text-xs"
                  placeholder="https://llm.example.com/api"
                />
              </Field>
              <div className="flex items-end gap-3">
                <Field label="model" hint="optional — forced default (endpoints that don't serve Claude's)">
                  <Input
                    value={row.model ?? ''}
                    onChange={(e) => setRow(i, { model: e.target.value || undefined })}
                    className="w-40 font-mono text-xs"
                    placeholder="glm-5.2"
                  />
                </Field>
                <Button
                  variant="text"
                  color="secondary"
                  className="ml-auto"
                  onClick={() => setCustoms(customs.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
              {customErrors[i] !== undefined && (
                <div className="text-xs text-rose-600 dark:text-rose-400">{customErrors[i]}</div>
              )}
            </div>
          ))}
        </div>

        <div className="rounded-md border-l-4 border-sky-500/50 bg-sky-500/5 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
            Credentials
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            LLM credentials are inherited from your environment / keychain and never stored by the app or sent
            over any API. A custom provider stores only the <em>name</em> of the environment variable holding
            its key.
          </p>
        </div>
      </div>
      )}
    </div>
  );
}
