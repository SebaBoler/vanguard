import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@/ui';
import { apiComplete, apiCreateTask, listDrafts, readDraft, readAppConfig } from '../../ipc.js';
import { useNavGuardRegistry } from '../../navGuard.js';
import { relTime } from '../../time.js';
import { DocEditor } from './DocEditor.js';
import { ChatPane } from './ChatPane.js';
import { CreateTaskDialog } from './CreateTaskDialog.js';
import { titleFromDoc, isTransport, MAX_BODY_BYTES, MAX_TITLE_BYTES } from './docTask.js';
import { reduceDocChat, initialDocChat } from './useDocChat.js';
import { DraftWriter, draftLabel, emptyDraft, mintDraftId, parseDraft, type DraftData } from './draftStore.js';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';

/** System prompt for the idea→plan preset. It is a chat preset, NOT the sandboxed `planner` stage. */
const PLAN_PRESET =
  'You help turn a rough idea into a clear implementation plan. Reply conversationally. When you ' +
  'propose changes to the document, return the ENTIRE revised document verbatim inside <doc>...</doc> ' +
  'tags (put any commentary OUTSIDE the tags). If you are only answering a question, omit the tags.';

/** A sidebar entry: `data === undefined` ⇒ unreadable file — visible and deletable, never hidden. */
interface DraftEntry {
  id: string;
  data?: DraftData;
}

// Session memory (S10 spec §3.2): re-entering the screen restores the draft the user was on;
// only an explicit New Task click (nonce bump) forces a fresh one. Module-level because the
// screen unmounts on every screen/project switch.
const lastSelection = new Map<string, string>();
const consumedNonce = { value: 0 };

/**
 * The New Task screen (S10): drafts sidebar + markdown editor + chat. One draft = one JSON file
 * under `.vanguard/drafts/` — created lazily on the first non-empty edit or chat send, never on
 * click. Filing the draft as a task archives it in place.
 */
export function TaskDraftScreen({
  project,
  freshNonce,
  onOpenBoard,
}: {
  project: string;
  freshNonce: number;
  onOpenBoard: () => void;
}) {
  const [entries, setEntries] = useState<DraftEntry[]>([]);
  const entriesRef = useRef<DraftEntry[]>([]);
  entriesRef.current = entries;
  // null ⇒ a fresh, unsaved draft (no file on disk yet).
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [body, setBody] = useState('');
  const [chat, dispatch] = useReducer(reduceDocChat, undefined, initialDocChat);
  const [archived, setArchived] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  // The authoritative persisted shape for the OPEN draft. A ref, not state: the mint and the
  // first write must see the value the keystroke that triggered them produced — synchronously.
  // Every hand-off to the writer is a SNAPSHOT (`{ ...draftRef.current }`), never the ref itself:
  // a draft switch repoints this ref, and an aliased read in a later microtask would serialize
  // the incoming draft's state into the outgoing draft's file (review #349 r2).
  const draftRef = useRef<DraftData>(emptyDraft());

  const [saveError, setSaveError] = useState<string | null>(null);
  const writerRef = useRef<DraftWriter | null>(null);
  writerRef.current ??= new DraftWriter(project, setSaveError);
  const writer = writerRef.current;

  // Chat / create guards, carried from DocsScreen (S3/S4 review-hardened) — but keyed by draft id
  // (review #349 r1): a selection-scoped ref is cleared by a switch, so leaving and returning to a
  // draft mid-completion would let a second send fire and persist a duplicate assistant turn.
  const pendingTurns = useRef(new Set<string>());
  // Holds the draft id being filed. NOT cleared on draft switch: persistence is id-keyed now, and
  // a stale create settling must never disarm a newer one — it releases only its own id.
  const createInFlight = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);

  useEffect(() => {
    void readAppConfig(project)
      .then((cfg) => setSource(isTransport(cfg.source ?? 'github') ? (cfg.source ?? 'github') : undefined))
      .catch(() => setSource(undefined));
  }, [project]);

  /** Push the open draft's current shape into the sidebar cache (labels, archived section). */
  const syncEntry = (id: string): void => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, data: { ...draftRef.current } } : e)));
  };

  /**
   * THE switch routine (spec §3.3): every path — sidebar click, New Task nonce, delete fallback,
   * duplicate — goes through here. Flushes the pending save of the draft being left (a deleted
   * draft's timer was already discarded, so a delete can't resurrect), resets the in-flight chat
   * slot and create UI, and loads the target synchronously from the sidebar cache (the app is the
   * only writer of these files, so the cache is authoritative — no async read to race).
   */
  const switchTo = (id: string | null): void => {
    void writer.flush();
    setConfirming(false);
    setCreating(false);
    setCreateError(null);
    setSaveError(null);
    setDeleteArm(null);
    activeIdRef.current = id;
    setActiveId(id);
    if (id === null) {
      lastSelection.delete(project);
      draftRef.current = emptyDraft();
      setUnreadable(false);
      setBody('');
      setArchived(false);
      setCreated(null);
      dispatch({ type: 'reset' });
      return;
    }
    lastSelection.set(project, id);
    const entry = entriesRef.current.find((e) => e.id === id);
    if (entry?.data === undefined) {
      // Unreadable: selectable only so it can be deleted.
      draftRef.current = emptyDraft();
      setUnreadable(true);
      setBody('');
      setArchived(false);
      setCreated(null);
      dispatch({ type: 'reset' });
      return;
    }
    draftRef.current = { ...entry.data };
    setUnreadable(false);
    setBody(entry.data.body);
    setArchived(entry.data.archived);
    setCreated(entry.data.created ?? null);
    // Re-present as busy when this draft's completion is still in flight — its reply will land
    // through the id-keyed path, and a second send meanwhile must stay blocked.
    dispatch({ type: 'load', messages: entry.data.chat, busy: pendingTurns.current.has(id) });
  };
  const switchRef = useRef(switchTo);
  switchRef.current = switchTo;

  // Load the sidebar once per mount, then pick the initial selection: a fresh draft when this
  // mount was caused by a New Task click (unconsumed nonce), the remembered draft otherwise.
  useEffect(() => {
    let alive = true;
    void listDrafts(project)
      .then(async (ids) => {
        const loaded: DraftEntry[] = await Promise.all(
          ids.map(async (id) => {
            const raw = await readDraft(project, id).catch(() => undefined);
            const data = raw !== undefined ? parseDraft(raw) : undefined;
            return data !== undefined ? { id, data } : { id };
          }),
        );
        if (!alive) return;
        setEntries(loaded);
        entriesRef.current = loaded;
        if (freshNonce !== consumedNonce.value) {
          consumedNonce.value = freshNonce;
          switchRef.current(null);
        } else {
          const remembered = lastSelection.get(project);
          switchRef.current(remembered !== undefined && loaded.some((e) => e.id === remembered) ? remembered : null);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // A New Task click while already mounted resets to a fresh draft — through the switch routine.
  useEffect(() => {
    if (freshNonce !== consumedNonce.value) {
      consumedNonce.value = freshNonce;
      switchRef.current(null);
    }
  }, [freshNonce]);

  // Close-flush (spec §3.3): window close awaits pending writes through the nav-guard flush hook.
  // Screen/project switches don't need it — the unmount flush's invoke outlives the component in
  // a living webview.
  const navGuard = useNavGuardRegistry();
  useEffect(() => {
    const flush = (): Promise<void> => writer.flush();
    navGuard?.registerFlush(flush);
    return () => {
      navGuard?.unregisterFlush(flush);
      void writer.flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Mint on first persist-triggering event — shared synchronously by the body and chat paths. */
  const ensureId = (): string => {
    const existing = activeIdRef.current;
    if (existing !== null) return existing;
    const id = mintDraftId();
    activeIdRef.current = id;
    setActiveId(id);
    lastSelection.set(project, id);
    setEntries((prev) => [{ id, data: { ...draftRef.current } }, ...prev]);
    return id;
  };

  const onBodyChange = (next: string): void => {
    if (archived || unreadable) return;
    setBody(next);
    draftRef.current = { ...draftRef.current, body: next };
    // Lazy creation: N clicks on New Task write zero files; the first non-empty edit mints one.
    if (activeIdRef.current === null && next === '') return;
    const id = ensureId();
    syncEntry(id);
    writer.schedule(id, { ...draftRef.current });
  };

  const send = (text: string): void => {
    if (archived || unreadable) return;
    // Per-id single-in-flight: synchronous, so a double click cannot slip between renders, and a
    // draft switch cannot clear another draft's slot.
    if (activeIdRef.current !== null && pendingTurns.current.has(activeIdRef.current)) return;
    const id = ensureId();
    pendingTurns.current.add(id);
    const apiMessages = [...chat.messages, { role: 'user' as const, content: text }];
    // Snapshot the body SYNCHRONOUSLY, like apiMessages (review #349 r5 blocking): the .then below
    // runs after an IPC round-trip, and a draft switch in that window repoints draftRef — reading
    // it late would send the newly opened draft's body (possibly secrets) as this turn's <doc>.
    const bodyAtSend = draftRef.current.body;
    dispatch({ type: 'send', text });
    draftRef.current = { ...draftRef.current, chat: [...draftRef.current.chat, { role: 'user', content: text }] };
    syncEntry(id);
    // Chat turns are written immediately (never debounced): their loss crosses a process boundary.
    void writer.writeNow(id, { ...draftRef.current });
    void readAppConfig(project)
      .then((cfg) =>
        apiComplete(project, {
          system: `${PLAN_PRESET}\n\nThe current document is:\n<doc>${bodyAtSend}</doc>`,
          messages: apiMessages,
          model: cfg.chatModel ?? DEFAULT_CHAT_MODEL,
        }),
      )
      .then((res) => {
        if (res.error !== undefined) {
          if (id === activeIdRef.current) dispatch({ type: 'fail', message: res.error.message });
          return;
        }
        const reply = res.text ?? '';
        if (id === activeIdRef.current) {
          dispatch({ type: 'reply', text: reply });
          draftRef.current = { ...draftRef.current, chat: [...draftRef.current.chat, { role: 'assistant', content: reply }] };
          syncEntry(id);
          void writer.writeNow(id, { ...draftRef.current });
        } else {
          // Late reply after a draft switch: dropped from the UI (the gen rule), but appended to
          // the file it was issued for — a persisted transcript must not end on a dangling user
          // turn. `update` skips a deleted file, so this can never resurrect one.
          void writer.update(id, (d) => ({ ...d, chat: [...d.chat, { role: 'assistant', content: reply }] }));
          setEntries((prev) =>
            prev.map((e) =>
              e.id === id && e.data !== undefined
                ? { ...e, data: { ...e.data, chat: [...e.data.chat, { role: 'assistant', content: reply }] } }
                : e,
            ),
          );
        }
      })
      .catch((err: unknown) => {
        if (id === activeIdRef.current) dispatch({ type: 'fail', message: String(err) });
      })
      .finally(() => {
        pendingTurns.current.delete(id);
      });
  };

  const accept = (): void => {
    if (chat.pending === undefined || archived) return;
    const next = chat.pending;
    setBody(next);
    draftRef.current = { ...draftRef.current, body: next };
    dispatch({ type: 'acceptApplied' });
    const id = ensureId();
    syncEntry(id);
    void writer.writeNow(id, { ...draftRef.current });
  };

  const docTitle = titleFromDoc(body);
  const bodyBytes = new TextEncoder().encode(body).length;
  const tooBig = bodyBytes > MAX_BODY_BYTES;
  const titleTooLong = docTitle !== undefined && new TextEncoder().encode(docTitle).length > MAX_TITLE_BYTES;

  const createTask = (): void => {
    const id = activeIdRef.current;
    if (createInFlight.current !== null || id === null || docTitle === undefined || archived) return;
    createInFlight.current = id;
    setCreating(true);
    setCreateError(null);
    // Make sure the file reflects what is being filed BEFORE the create: the archive write below
    // is a read-modify-write, and a debounce firing after it would regress `archived` (spec G14).
    writer.discard(id);
    void writer.writeNow(id, { ...draftRef.current });
    void apiCreateTask(project, docTitle, draftRef.current.body)
      .then(async (task) => {
        // The one rule the whole subsystem hangs on (spec G1): this write is keyed to the id
        // captured at click time and runs regardless of what is selected NOW — a filed draft
        // must never stay re-filable because the user switched away mid-create.
        // Belt to the readOnly gate: if the user switched away and typed on this draft elsewhere
        // during the flight, an armed archived:false snapshot must not land after the archive.
        writer.discard(id);
        const outcome = await writer.update(id, (d) => ({ ...d, archived: true, created: task }));
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id && e.data !== undefined ? { ...e, data: { ...e.data, archived: true, created: task } } : e,
          ),
        );
        if (id === activeIdRef.current) {
          draftRef.current = { ...draftRef.current, archived: true, created: task };
          setArchived(true);
          setCreated(task);
          if (outcome === 'failed') {
            setCreateError(`The issue WAS created (${task.id}) but the draft could not be archived — do not re-file it.`);
          }
        }
      })
      .catch((err: unknown) => {
        if (id === activeIdRef.current) {
          setCreateError(
            `${String(err)} — the issue may or may not have been created. Check ${source ?? 'the tracker'} before retrying.`,
          );
        }
      })
      .finally(() => {
        // Release only our own slot: a newer create on another draft owns it now.
        if (createInFlight.current === id) createInFlight.current = null;
        if (id === activeIdRef.current) {
          setCreating(false);
          setConfirming(false);
        }
      });
  };

  const removeDraft = (id: string): void => {
    setDeleteArm(null);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    // deleteNow discards the pending debounce first and queues after any in-flight write — the
    // delete wins; the file cannot resurrect (spec G2).
    void writer.deleteNow(id);
    if (id === activeIdRef.current) switchTo(null);
  };

  const duplicate = (src: DraftData): void => {
    switchTo(null);
    const id = mintDraftId();
    activeIdRef.current = id;
    setActiveId(id);
    lastSelection.set(project, id);
    // Stamped here too (not just at write): the sidebar row renders this copy's time immediately.
    draftRef.current = { body: src.body, chat: [...src.chat], archived: false, updatedAt: new Date().toISOString() };
    setBody(src.body);
    dispatch({ type: 'load', messages: src.chat });
    setEntries((prev) => [{ id, data: { ...draftRef.current } }, ...prev]);
    void writer.writeNow(id, { ...draftRef.current });
  };

  const rowLabel = useCallback((e: DraftEntry): string => {
    return e.data === undefined ? `${e.id} (unreadable)` : draftLabel(e.data);
  }, []);
  const rowTime = (e: DraftEntry): string | null => {
    const ms = e.data !== undefined ? Date.parse(e.data.updatedAt) : NaN;
    return Number.isNaN(ms) ? null : relTime(ms);
  };

  const activeDrafts = entries.filter((e) => e.data === undefined || !e.data.archived);
  const archivedDrafts = entries.filter((e) => e.data?.archived === true);

  const draftRow = (e: DraftEntry): React.ReactElement => (
    <div key={e.id} className="group relative">
      <button
        onClick={() => {
          if (e.id !== activeId) switchTo(e.id);
        }}
        className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${e.id === activeId ? 'bg-muted/40' : 'hover:bg-muted/20'}`}
      >
        <span className={e.data === undefined ? 'text-muted-foreground' : ''}>{rowLabel(e)}</span>
        {rowTime(e) !== null && <span className="ml-1 text-[11px] text-muted-foreground">{rowTime(e)}</span>}
      </button>
      {deleteArm === e.id ? (
        <span className="absolute right-1 top-1 flex gap-1 rounded bg-background px-1 text-xs shadow">
          <button className="text-destructive" onClick={() => removeDraft(e.id)}>
            delete
          </button>
          <button className="text-muted-foreground" onClick={() => setDeleteArm(null)}>
            keep
          </button>
        </span>
      ) : (
        <button
          aria-label={`delete ${rowLabel(e)}`}
          onClick={() => setDeleteArm(e.id)}
          className="absolute right-1 top-1 hidden rounded px-1 text-xs text-muted-foreground hover:text-destructive group-hover:block"
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full gap-3">
      <div className="w-56 shrink-0 space-y-1 overflow-auto border-r border-border pr-2">
        <Button onClick={() => switchTo(null)} className="w-full">
          New draft
        </Button>
        {activeId === null && (
          <div className="rounded bg-muted/40 px-2 py-1 text-sm text-muted-foreground">New task…</div>
        )}
        {activeDrafts.map(draftRow)}
        {archivedDrafts.length > 0 && (
          <>
            <div className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Archived
            </div>
            {archivedDrafts.map(draftRow)}
          </>
        )}
      </div>
      <div className="flex-1" onBlur={() => void writer.flush()}>
        {unreadable ? (
          <p className="p-4 text-sm text-muted-foreground">
            This draft file could not be read — it can only be deleted.
          </p>
        ) : (
          <DocEditor
            value={body}
            onChange={onBodyChange}
            // confirming/creating too (review #349 r4): a keystroke while the create is in flight
            // would arm an archived:false debounce that lands AFTER the archive write.
            readOnly={chat.pending !== undefined || archived || confirming || creating}
          />
        )}
      </div>
      <div className="flex w-80 shrink-0 flex-col gap-2 border-l border-border pl-3">
        <div className="shrink-0">
          {archived && created !== null ? (
            <div className="space-y-2">
              <p className="truncate text-sm">
                Filed as{' '}
                <a href={created.url} target="_blank" rel="noreferrer" className="underline">
                  {created.id}
                </a>
              </p>
              <div className="flex gap-2">
                <Button onClick={onOpenBoard} className="flex-1">
                  Open board
                </Button>
                <Button variant="outlined" color="secondary" onClick={() => duplicate(draftRef.current)}>
                  Duplicate
                </Button>
              </div>
            </div>
          ) : (
            !unreadable && (
              <>
                <Button
                  onClick={() => setConfirming(true)}
                  disabled={
                    docTitle === undefined ||
                    tooBig ||
                    titleTooLong ||
                    source === undefined ||
                    chat.pending !== undefined ||
                    archived
                  }
                  className="w-full"
                >
                  Create task
                </Button>
                {source === undefined && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Can&apos;t read the task source from <code>app.json</code> — set it in Settings.
                  </p>
                )}
                {titleTooLong && (
                  <p className="mt-1 text-xs text-destructive">
                    Heading is too long to use as a title (max {MAX_TITLE_BYTES} bytes).
                  </p>
                )}
                {tooBig && (
                  <p className="mt-1 text-xs text-destructive">
                    Too long to file ({bodyBytes} / {MAX_BODY_BYTES} bytes).
                  </p>
                )}
                {docTitle === undefined && (
                  <p className="mt-1 text-xs text-muted-foreground">Add a `# heading` to name the task.</p>
                )}
              </>
            )
          )}
          {createError !== null && <p className="mt-1 text-xs text-destructive">{createError}</p>}
          {saveError !== null && <p className="mt-1 text-xs text-destructive">{saveError}</p>}
        </div>
        <div className="min-h-0 flex-1">
          <ChatPane
            state={chat}
            disabled={archived || unreadable}
            onSend={send}
            onAccept={accept}
            onReject={() => dispatch({ type: 'reject' })}
          />
        </div>
      </div>

      {confirming && docTitle !== undefined && source !== undefined && !titleTooLong && !tooBig && (
        <CreateTaskDialog
          source={source}
          title={docTitle}
          bodyBytes={bodyBytes}
          busy={creating}
          onConfirm={createTask}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
