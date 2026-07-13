import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button, CodeBlock, Input } from '@/ui';
import { AlertTriangle, Plus } from 'lucide-react';
import { apiCapabilitiesCached, apiListFlows, apiReadFlow, apiWriteFlow } from '../../ipc';
import type { Capabilities, RepoFlowInfo } from '../../ipc';
import { FlowCanvas } from './FlowCanvas';
import { StageInspector } from './StageInspector';
import { FLOW_NAME_RE, flowEditorReducer, initialFlowEditor } from './flowEditorReducer';

/**
 * The visual flow editor (S5 §18-20): reads and writes real `.vanguard/flows/*.hcl` through the
 * sidecar. Rail = discovered flows (unparseable entries disabled; parsed-but-invalid entries
 * selectable with an error badge — fixing them is what this screen is for). Canvas = stage blocks
 * in source order. Inspector = overrides for the selected stage. The doc's `meta` and `loop`
 * blocks survive every edit verbatim (reducer invariant). AppConfig editing moved out entirely —
 * Settings owns every one of those fields.
 */
export function WorkflowEditor({ project }: { project: string }) {
  const [flows, setFlows] = useState<RepoFlowInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [tab, setTab] = useState<'canvas' | 'source'>('canvas');
  const [newName, setNewName] = useState('');
  const [state, dispatch] = useReducer(flowEditorReducer, initialFlowEditor);
  // Bumped on every project switch; an in-flight list/read whose generation is stale is dropped
  // so a resolved response can never land on another project's editor (async-per-context rule).
  const gen = useRef(0);
  const saving = useRef(false);

  const refreshList = useCallback(async (): Promise<void> => {
    const issued = gen.current;
    try {
      const { flows: next } = await apiListFlows(project);
      if (issued === gen.current) {
        setFlows(next);
        setListError(null);
      }
    } catch (err) {
      if (issued === gen.current) {
        setFlows([]);
        setListError(String(err));
      }
    }
  }, [project]);

  useEffect(() => {
    gen.current += 1;
    dispatch({ type: 'reset' });
    setFlows(null);
    setListError(null);
    void refreshList();
    apiCapabilitiesCached()
      .then(setCaps)
      .catch(() => {});
  }, [project, refreshList]);

  const open = (file: string): void => {
    const issued = gen.current;
    apiReadFlow(project, file)
      .then(({ doc, source }) => {
        if (issued === gen.current) dispatch({ type: 'loaded', file, doc, source });
      })
      .catch((err) => {
        if (issued === gen.current) dispatch({ type: 'loadFailed', file, error: String(err) });
      });
  };

  const save = async (): Promise<void> => {
    // ref, not state: reducer state only updates on the next render — a double-click slips through.
    if (saving.current || state.file === null || state.doc === null) return;
    saving.current = true;
    const issued = gen.current;
    try {
      const { source } = await apiWriteFlow(project, state.file, state.doc);
      if (issued === gen.current) {
        dispatch({ type: 'saveOk', source });
        void refreshList();
      }
    } catch (err) {
      if (issued === gen.current) dispatch({ type: 'saveFailed', error: String(err) });
    } finally {
      saving.current = false;
    }
  };

  // Built-ins are absent from listFlows, so the create-form must check capabilities too — a
  // collision with "plan" would otherwise surface only at Save (S5 §19).
  const takenNames = new Set([...(caps?.flows.map((f) => f.name) ?? []), ...(flows?.map((f) => f.name).filter((n): n is string => n !== undefined) ?? [])]);
  const newNameProblem =
    newName === ''
      ? null
      : !FLOW_NAME_RE.test(newName)
        ? 'lowercase letters, digits, . _ - only'
        : takenNames.has(newName)
          ? `"${newName}" is taken`
          : null;

  const palette = caps?.stages ?? [];
  const selectedStage = state.doc !== null && state.selected !== null ? state.doc.stages[state.selected] : undefined;
  const saveDisabled = !state.dirty || state.doc === null || state.doc.stages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-3">
        <h2 className="font-semibold">Flows</h2>
        {state.file !== null && <code className="text-xs text-muted-foreground">.vanguard/flows/{state.file}</code>}
        {state.dirty && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">unsaved</span>
        )}
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
          <Button onClick={() => void save()} disabled={saveDisabled}>
            Save
          </Button>
        </div>
      </div>

      {state.error !== null && (
        <div className="flex shrink-0 items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {state.error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'source' ? (
          state.source !== null ? (
            <CodeBlock code={state.source} lang="hcl" />
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {state.doc !== null ? 'Not saved yet — the canonical HCL appears after the first save.' : 'Select a flow.'}
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[200px_1fr_280px]">
            <div className="rounded-lg border border-border p-2">
              <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Flows</div>
              {listError !== null && <div className="px-1 pb-2 text-xs text-destructive">{listError}</div>}
              {flows !== null && flows.length === 0 && listError === null && (
                <div className="px-1 pb-2 text-xs text-muted-foreground">No flows yet — create one below.</div>
              )}
              <div className="space-y-1">
                {(flows ?? []).map((f) => {
                  const openable = f.name !== undefined;
                  return (
                    <button
                      key={f.file}
                      disabled={!openable}
                      onClick={() => open(f.file)}
                      title={f.error}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                        state.file === f.file ? 'bg-muted font-medium' : openable ? 'hover:bg-muted/60' : 'opacity-50'
                      }`}
                    >
                      <span className="truncate">{f.name ?? f.file}</span>
                      {f.error !== undefined && <AlertTriangle className="ml-auto size-3.5 shrink-0 text-amber-500" aria-hidden />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 space-y-1 border-t border-border pt-2">
                <div className="flex items-center gap-1">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="new-flow-name"
                    className="w-full text-xs"
                  />
                  <Button
                    aria-label="create flow"
                    disabled={newName === '' || newNameProblem !== null}
                    onClick={() => {
                      dispatch({ type: 'created', name: newName });
                      setNewName('');
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                  </Button>
                </div>
                {newNameProblem !== null && <div className="px-1 text-[11px] text-destructive">{newNameProblem}</div>}
              </div>
            </div>

            {state.doc !== null ? (
              <FlowCanvas
                doc={state.doc}
                palette={palette}
                selected={state.selected}
                onSelect={(index) => dispatch({ type: 'select', index })}
                onMove={(from, to) => dispatch({ type: 'moveStage', from, to })}
              />
            ) : (
              <div className="flex min-h-[24rem] items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
                Select a flow or create one.
              </div>
            )}

            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {selectedStage !== undefined ? `Stage — ${selectedStage.name}` : 'Palette'}
              </div>
              {selectedStage !== undefined && state.selected !== null ? (
                <StageInspector
                  stage={selectedStage}
                  palette={palette}
                  providers={caps?.providers ?? []}
                  onSetName={(name) => dispatch({ type: 'setStageName', index: state.selected!, name })}
                  onSetRef={(ref) => dispatch({ type: 'setRef', index: state.selected!, ref })}
                  onSetOverride={(key, value) => dispatch({ type: 'setOverride', index: state.selected!, key, value })}
                  onRemove={() => dispatch({ type: 'removeStage', index: state.selected! })}
                />
              ) : state.doc !== null ? (
                <div className="space-y-1">
                  {palette.map((s) => (
                    <button
                      key={s}
                      onClick={() => dispatch({ type: 'addStage', name: s })}
                      className="flex w-full items-center gap-2 rounded border border-border px-2 py-1.5 text-left text-sm hover:border-primary/40"
                    >
                      <Plus className="size-3.5 text-muted-foreground" aria-hidden />
                      {s}
                    </button>
                  ))}
                  {/* no ref yet on purpose: the block renders with the "add a ref" warning until the
                      inspector's ref field is filled — an empty ref must never save as healthy */}
                  <button
                    onClick={() => dispatch({ type: 'addStage', name: 'custom' })}
                    className="flex w-full items-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-left text-sm text-muted-foreground hover:border-primary/40"
                  >
                    <Plus className="size-3.5" aria-hidden />
                    custom ref stage…
                  </button>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">Stages appear here once a flow is open.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
