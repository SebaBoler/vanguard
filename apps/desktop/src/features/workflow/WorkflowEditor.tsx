import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useNavGuardRegistry } from '../../navGuard';
import { Button, CodeBlock, Input } from '@/ui';
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiCapabilitiesCached, apiDeleteFlow, apiListFlows, apiReadFlow, apiWriteFlow } from '../../ipc';
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
  const [capsError, setCapsError] = useState<string | null>(null);
  const [tab, setTab] = useState<'canvas' | 'source'>('canvas');
  const [newName, setNewName] = useState('');
  const [state, dispatch] = useReducer(flowEditorReducer, initialFlowEditor);
  // Bumped on every project switch; an in-flight list/read whose generation is stale is dropped
  // so a resolved response can never land on another project's editor (async-per-context rule).
  const gen = useRef(0);
  const saving = useRef(false);

  // Unsaved edits must never vanish on a stray click — the same discipline saveFailed follows.
  const confirmDiscard = (): boolean =>
    !state.dirty || window.confirm(`Discard unsaved changes to ${state.doc?.name ?? state.file}?`);

  // Shell-level navigations (project switch, Rail screen switch, home, remove, running-run open,
  // window close) unmount/remount this whole component — the local confirmDiscard above never
  // fires for them. While dirty, register it with the App's nav-guard registry (S8, #339).
  const navGuard = useNavGuardRegistry();
  const confirmRef = useRef(confirmDiscard);
  confirmRef.current = confirmDiscard;
  useEffect(() => {
    if (navGuard === null || !state.dirty) return;
    const guard = (): boolean => confirmRef.current();
    navGuard.register(guard);
    return () => navGuard.unregister(guard);
  }, [navGuard, state.dirty]);

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
    // caps/capsError deliberately NOT reset here: capabilities are global + session-cached (see
    // the fetch below). If they ever become project-scoped, reset them with the rest.
    void refreshList();
    // A swallowed failure here would silently disable the built-in collision guard AND empty the
    // palette (review #338 r2) — surface it, and gate create on caps being loaded.
    // Deliberately NOT gen-guarded (unlike every other async path here): caps are session-cached
    // and context-FREE — and gen also bumps on every flow open, so a guard would drop the caps of
    // anyone who clicks a flow before they resolve, leaving the palette empty for the session.
    // Guard only what is scoped to a context; caps aren't. (Review r3 asked for the guard; this is
    // the reasoned refusal.)
    apiCapabilitiesCached()
      .then((c) => {
        setCaps(c);
        setCapsError(null);
      })
      .catch((err) => setCapsError(String(err)));
  }, [project, refreshList]);

  const open = (file: string): void => {
    // Re-clicking the open flow is a no-op — reloading would silently replace dirty edits with the
    // on-disk content, the one discard path the confirm below wouldn't cover. Only when a doc is
    // actually loaded: after loadFailed the same click must RETRY, not dead-end (error recovery is
    // what this editor is for).
    if (file === state.file && state.doc !== null) return;
    if (!confirmDiscard()) return;
    // Bump, don't just read: opening a flow invalidates every in-flight read AND save for the one
    // we're leaving — a slower earlier read must not clobber this selection, and a late saveOk
    // must not overwrite this flow's source/dirty (saveOk is not file-keyed).
    const issued = ++gen.current;
    // The old save's result is gen-guarded now, so release its lock too — a hung save on the flow
    // we're leaving must not silently block saving this one (review #338 r2).
    saving.current = false;
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
    const savedDoc = state.doc; // the exact snapshot shipped — saveOk clears dirty only if still current
    try {
      const { source } = await apiWriteFlow(project, state.file, savedDoc);
      if (issued === gen.current) {
        dispatch({ type: 'saveOk', source, savedDoc });
        void refreshList();
      }
    } catch (err) {
      if (issued === gen.current) dispatch({ type: 'saveFailed', error: String(err) });
    } finally {
      // Only release the CURRENT flow's lock: after a switch, open() already released it for the
      // new flow, and a save may be in flight there — this stale finally must not unlock it.
      if (issued === gen.current) saving.current = false;
    }
  };

  // Built-ins are absent from listFlows, so the create-form must check capabilities too — a
  // collision with "plan" would otherwise surface only at Save (S5 §19). FILE basenames are in the
  // set as well as names: an unparseable file has no name, but `created` writes to <name>.hcl and
  // would silently clobber it (review r4).
  const takenNames = (excludeFile?: string): Set<string> =>
    new Set([
      ...(caps?.flows.map((f) => f.name) ?? []),
      ...(flows ?? [])
        .filter((f) => f.file !== excludeFile)
        .flatMap((f) => [...(f.name !== undefined ? [f.name] : []), f.file.replace(/\.hcl$/, '')]),
    ]);
  const nameProblem = (name: string, excludeFile?: string): string | null =>
    name === ''
      ? null
      : !FLOW_NAME_RE.test(name)
        ? 'lowercase letters, digits, . _ - only'
        : takenNames(excludeFile).has(name)
          ? `"${name}" is taken`
          : null;
  const newNameProblem = nameProblem(newName);

  // Rename/delete (S8 item 6). Rename is COMPOSITION, not protocol: write the new file first,
  // delete the old second — a failure between the two leaves both files (messy, never lossy).
  const [renaming, setRenaming] = useState<string | null>(null); // file being renamed
  const [renameTo, setRenameTo] = useState('');
  const [opError, setOpError] = useState<string | null>(null);
  // ref, not state (reducer-state lag lets a double-click slip through — the save() lesson):
  // rename/delete are destructive IPC sequences; exactly one may be in flight.
  const opBusy = useRef(false);
  const renameProblem = renaming !== null ? nameProblem(renameTo, renaming) : null;

  const removeFlow = async (file: string): Promise<void> => {
    if (opBusy.current) return;
    if (!window.confirm(`Delete ${file} from .vanguard/flows/?`)) return;
    opBusy.current = true;
    try {
      await apiDeleteFlow(project, file);
      setOpError(null);
      if (state.file === file) {
        gen.current += 1; // invalidate in-flight reads/saves of the deleted flow
        saving.current = false;
        dispatch({ type: 'reset' });
      }
      void refreshList();
    } catch (err) {
      setOpError(String(err));
    } finally {
      opBusy.current = false;
    }
  };

  const renameFlow = async (file: string, to: string): Promise<void> => {
    if (opBusy.current) return;
    if (state.file === file && state.dirty) {
      setOpError('save or discard the unsaved changes before renaming this flow');
      return;
    }
    opBusy.current = true;
    try {
      const { doc } = await apiReadFlow(project, file); // the ON-DISK doc — rename never invents content
      const targetFile = `${to}.hcl`;
      await apiWriteFlow(project, targetFile, { ...doc, name: to });
      setOpError(null);
      // SAME-PATH rename (a hand-authored y.hcl declaring name "x", renamed to "y" — aligning the
      // name with the basename): the write above IS the whole operation. Deleting here would
      // remove the file just written — the flow would be GONE (review #345 r2, blocking).
      if (targetFile !== file) {
        try {
          await apiDeleteFlow(project, file);
        } catch (err) {
          // write-before-delete: the flow now exists under both names — say so, lose nothing.
          setOpError(`renamed to ${targetFile} but could not remove ${file}: ${String(err)} — both files exist`);
        }
      }
      setRenaming(null);
      if (state.file === file) {
        // Gen-guarded like open(): a stale reload landing after another open/delete bumped gen
        // must not clobber the newer selection (review #345 — the S5 async-context class again).
        const issued = ++gen.current;
        saving.current = false;
        apiReadFlow(project, `${to}.hcl`)
          .then(({ doc: d, source }) => {
            if (issued === gen.current) dispatch({ type: 'loaded', file: `${to}.hcl`, doc: d, source });
          })
          .catch((err) => {
            if (issued === gen.current) dispatch({ type: 'loadFailed', file: `${to}.hcl`, error: String(err) });
          });
      }
      void refreshList();
    } catch (err) {
      setOpError(String(err));
    }
  };

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
      {opError !== null && (
        <div className="flex shrink-0 items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {opError}
        </div>
      )}
      {capsError !== null && (
        <div className="flex shrink-0 items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          stage palette unavailable — {capsError}. Creating flows and adding library stages need it.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'source' ? (
          state.source !== null ? (
            <div>
              {state.dirty && (
                <div className="mb-2 text-xs text-muted-foreground">
                  stale — reflects the last save, not your unsaved edits (Save regenerates it)
                </div>
              )}
              <CodeBlock code={state.source} lang="hcl" />
            </div>
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
                  if (renaming === f.file) {
                    return (
                      <div key={f.file} className="space-y-1 rounded bg-muted/60 px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <Input
                            value={renameTo}
                            onChange={(e) => setRenameTo(e.target.value)}
                            aria-label={`rename ${f.name ?? f.file}`}
                            className="w-full text-xs"
                          />
                          <Button
                            aria-label="confirm rename"
                            disabled={renameTo === '' || renameProblem !== null || renameTo === f.name}
                            onClick={() => void renameFlow(f.file, renameTo)}
                          >
                            <Pencil className="size-3.5" aria-hidden />
                          </Button>
                          <Button variant="text" color="secondary" aria-label="cancel rename" onClick={() => setRenaming(null)}>
                            ✕
                          </Button>
                        </div>
                        {renameProblem !== null && <div className="px-1 text-[11px] text-destructive">{renameProblem}</div>}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={f.file}
                      className={`group flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${
                        state.file === f.file ? 'bg-muted font-medium' : openable ? 'hover:bg-muted/60' : 'opacity-50'
                      }`}
                    >
                      <button
                        disabled={!openable}
                        onClick={() => open(f.file)}
                        title={f.error}
                        aria-label={`open ${f.name ?? f.file}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="truncate">{f.name ?? f.file}</span>
                        {f.error !== undefined && <AlertTriangle className="ml-auto size-3.5 shrink-0 text-amber-500" aria-hidden />}
                      </button>
                      {openable && (
                        <button
                          aria-label={`rename ${f.name}`}
                          onClick={() => {
                            setRenaming(f.file);
                            setRenameTo(f.name ?? '');
                          }}
                          className="hidden shrink-0 text-muted-foreground hover:text-foreground group-hover:block"
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </button>
                      )}
                      <button
                        aria-label={`delete ${f.name ?? f.file}`}
                        onClick={() => void removeFlow(f.file)}
                        className="hidden shrink-0 text-muted-foreground hover:text-destructive group-hover:block"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
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
                    // caps gate: without the built-in flow names the collision check can't run, and a
                    // "plan" collision would surface first at Save — exactly what the form exists to prevent
                    disabled={newName === '' || newNameProblem !== null || caps === null}
                    onClick={() => {
                      if (!confirmDiscard()) return;
                      gen.current += 1; // same invalidation as open(): a late read/save must not land on the new doc
                      saving.current = false;
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
                  key={state.selected}
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
