import { type ReactNode } from 'react';
import { Button, Input } from '@/ui';
import { Trash2 } from 'lucide-react';
import { EnumSelect } from '../inspector/EnumSelect';
import type { StageDecl, StageOverrides } from '../../ipc';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Sentinel for "no override — inherit the library default" in the selects. */
const INHERIT = '';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Override editor for the selected stage (S5 §18). Every field maps 1:1 to a StageOverrides key
 * (empty = no override, the library default applies); `name` selects from the capabilities stage
 * palette — a name that is in neither the palette nor backed by a ref is shown as "(not in
 * library)" so a broken hand-authored flow can be FIXED here rather than being unopenable.
 */
export function StageInspector({
  stage,
  palette,
  providers,
  onSetName,
  onSetRef,
  onSetOverride,
  onRemove,
}: {
  stage: StageDecl;
  palette: string[];
  providers: string[];
  onSetName: (name: string) => void;
  onSetRef: (ref: string) => void;
  onSetOverride: <K extends keyof StageOverrides>(key: K, value: StageOverrides[K]) => void;
  onRemove: () => void;
}) {
  const nameOptions = [
    ...palette.map((s) => ({ value: s, label: s })),
    ...(palette.includes(stage.name) ? [] : [{ value: stage.name, label: `${stage.name} (not in library)` }]),
  ];
  const o = stage.overrides;

  return (
    <div className="space-y-3">
      <Field label="Stage">
        <EnumSelect value={stage.name} onValueChange={onSetName} options={nameOptions} />
      </Field>
      <Field label="ref (custom TS step, relpath#export under .vanguard/)">
        <Input
          value={stage.ref ?? ''}
          onChange={(e) => onSetRef(e.target.value)}
          placeholder="scripts/custom.ts#myStage"
          className="w-full font-mono text-xs"
        />
      </Field>
      <Field label="model (empty = library default)">
        <Input value={o.model ?? ''} onChange={(e) => onSetOverride('model', e.target.value || undefined)} className="w-full" />
      </Field>
      <Field label="effort">
        <EnumSelect
          value={o.effort ?? INHERIT}
          onValueChange={(v) => onSetOverride('effort', v === INHERIT ? undefined : (v as StageOverrides['effort']))}
          options={[{ value: INHERIT, label: 'inherit' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
        />
      </Field>
      <Field label="max_turns">
        <Input
          type="number"
          value={o.maxTurns ?? ''}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value === '') onSetOverride('maxTurns', undefined);
            else if (Number.isInteger(n) && n > 0) onSetOverride('maxTurns', n);
          }}
          className="w-full"
        />
      </Field>
      <Field label="provider">
        <EnumSelect
          value={o.provider ?? INHERIT}
          onValueChange={(v) => onSetOverride('provider', v === INHERIT ? undefined : v)}
          options={[{ value: INHERIT, label: 'inherit' }, ...providers.map((p) => ({ value: p, label: p }))]}
        />
      </Field>
      <Field label="resume_previous">
        <EnumSelect
          value={o.resumePrevious === undefined ? INHERIT : String(o.resumePrevious)}
          onValueChange={(v) => onSetOverride('resumePrevious', v === INHERIT ? undefined : v === 'true')}
          options={[
            { value: INHERIT, label: 'inherit' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
        />
      </Field>
      <Button variant="text" color="secondary" onClick={onRemove} startIcon={<Trash2 className="size-4" />}>
        Remove stage
      </Button>
    </div>
  );
}
