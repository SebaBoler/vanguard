import { useEffect, useReducer, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/ui';
import { apiComplete, apiCreateTask, listDrafts, readDraft, readAppConfig } from '../../ipc.js';
import { useNavGuardRegistry } from '../../navGuard.js';
import { relTime } from '../../time.js';
import { DocEditor } from './DocEditor.js';
import { ChatPane } from './ChatPane.js';
import { CreateTaskDialog } from './CreateTaskDialog.js';
import { TaskDrawer, type DrawerTab, type HistoryRow } from './TaskDrawer.js';
import { titleFromDoc, isTransport, MAX_BODY_BYTES, MAX_TITLE_BYTES } from './docTask.js';
import { reduceDocChat, initialDocChat } from './useDocChat.js';
import { DraftWriter, draftLabel, emptyDraft, mintDraftId, parseDraft, type DraftData } from './draftStore.js';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';

/** System prompt for the idea→plan preset. It is a chat preset, NOT the sandboxed `planner` stage. */
const PLAN_PRESET =
  'You help turn a rough idea into a clear implementation plan. Reply conversationally. When you ' +
  'propose changes to the document, return the ENTIRE revised document verbatim inside <doc>...</doc> ' +
  'tags (put any commentary OUTSIDE the tags). If you are only answering a question, omit the tags.';

/** One completion, fired after a conversation's first exchange, names the tab (handoff §3). */
const TITLE_PRESET =
  'Generate a short title (3 to 6 words) for this conversation. Reply with ONLY the title text — ' +
  'no quotes, no trailing punctuation.';

/** A known draft: `data === undefined` ⇒ unreadable file — listed and deletable, never openable. */
interface DraftEntry {
  id: string;
  data?: DraftData;
}

// Session memory (handoff §2): re-entering the screen restores the open tabs, active tab and
// drawer state; only an explicit New Task click (nonce bump) forces a fresh conversation.
// Module-level because the screen unmounts on every screen/project switch.
interface TabSession {
  openTabs: string[];
  activeId: string | null;
  drawerOpen: boolean;
  panel: 'chat' | 'history';
}
const sessions = new Map<string, TabSession>();
const consumedNonce = { value: 0 };

/**
 * The New Task screen, tabbed-drawer shape (task-page handoff): full-page markdown editor, a
 * header carrying the primary action, and a chat drawer whose tab strip holds one tab per open
 * conversation. One conversation == one draft == one JSON file under `.vanguard/drafts/` —
 * created lazily on the first non-empty edit or chat send, never on click. Filing the draft as a
 * task archives it in place. All S10 persistence invariants (id-keyed, snapshot-only hand-offs)
 * are carried over unchanged.
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
  // Captured ONCE per mount, before the session-store effect below can overwrite the map entry
  // with this mount's initial (pre-restore) state.
  const initialSession = useRef<TabSession | undefined>(sessions.get(project));

  const [entries, setEntries] = useState<DraftEntry[]>([]);
  const entriesRef = useRef<DraftEntry[]>([]);
  entriesRef.current = entries;
  // null ⇒ a fresh, unsaved draft (no file on disk yet) — rendered as the ephemeral fresh tab.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>(initialSession.current?.openTabs ?? []);
  const openTabsRef = useRef<string[]>(openTabs);
  openTabsRef.current = openTabs;
  const [drawerOpen, setDrawerOpen] = useState(initialSession.current?.drawerOpen ?? false);
  const [panel, setPanel] = useState<'chat' | 'history'>(initialSession.current?.panel ?? 'chat');
  // Ids with activity the user hasn't looked at: a reply/proposal that landed while the tab was
  // unfocused or the drawer closed. Drives the tab dots and the header badge.
  const [unseen, setUnseen] = useState<ReadonlySet<string>>(new Set());
  const [body, setBody] = useState('');
  const [chat, dispatch] = useReducer(reduceDocChat, undefined, initialDocChat);
  const [archived, setArchived] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  // The authoritative persisted shape for the OPEN draft. A ref, not state: the mint and the
  // first write must see the value the keystroke that triggered them produced — synchronously.
  // Every hand-off to the writer is a SNAPSHOT (`{ ...draftRef.current }`), never the ref itself:
  // a draft switch repoints this ref, and an aliased read in a later microtask would serialize
  // the incoming draft's state into the outgoing draft's file (review #349 r2).
  const draftRef = useRef<DraftData>(emptyDraft());

  const [saveError, setSaveError] = useState<string | null>(null);
  // Recreated when `project` changes (review #349 r9 note): today Inspector's key remounts this
  // screen per project, but a stale-repoPath writer silently writing into the previous repo must
  // not be load-bearing on a remount decided elsewhere.
  const writerRef = useRef<{ project: string; writer: DraftWriter } | null>(null);
  if (writerRef.current === null || writerRef.current.project !== project) {
    writerRef.current = { project, writer: new DraftWriter(project, setSaveError) };
  }
  const writer = writerRef.current.writer;

  // Chat / create guards (S3/S4 review-hardened), keyed by draft id (review #349 r1): a
  // selection-scoped ref is cleared by a switch, so leaving and returning to a draft
  // mid-completion would let a second send fire and persist a duplicate assistant turn.
  // `pendingIds` mirrors the ref into state so tab dots and the header badge re-render.
  const pendingTurns = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  // Holds the draft id being filed. NOT cleared on draft switch: persistence is id-keyed, and a
  // stale create settling must never disarm a newer one — it releases only its own id.
  const createInFlight = useRef<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [defaultModel, setDefaultModel] = useState(DEFAULT_CHAT_MODEL);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  // Ids the user deleted THIS session. The archive step needs to tell a deliberate delete (silent)
  // from a transient read/parse failure (review #349 r7): both surface as a non-'written' update,
  // but only the latter leaves a re-filable filed draft on disk and must warn.
  const deletedIds = useRef(new Set<string>());

  useEffect(() => {
    void readAppConfig(project)
      .then((cfg) => {
        setSource(isTransport(cfg.source ?? 'github') ? (cfg.source ?? 'github') : undefined);
        const resolved = cfg.chatModel ?? DEFAULT_CHAT_MODEL;
        setDefaultModel(resolved);
        // Every distinct model the vanguard configuration knows about (handoff §4) — the resolved
        // default is presented by the "default" option, so it is excluded here.
        const models = (cfg.customProviders ?? [])
          .map((p) => p.model)
          .filter((m): m is string => typeof m === 'string' && m.trim() !== '');
        setModelOptions([...new Set(models)].filter((m) => m !== resolved));
      })
      .catch(() => {
        setSource(undefined);
        setDefaultModel(DEFAULT_CHAT_MODEL);
        setModelOptions([]);
      });
  }, [project]);

  // Persist the tab session for this project — but only once the mount has decided its initial
  // selection, so the pre-restore render can't clobber the remembered session.
  const sessionReady = useRef(false);
  useEffect(() => {
    if (!sessionReady.current) return;
    sessions.set(project, { openTabs, activeId, drawerOpen, panel });
  }, [project, openTabs, activeId, drawerOpen, panel]);

  const markUnseen = (id: string): void => {
    setUnseen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };
  const clearUnseen = (id: string): void => {
    setUnseen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  /** Push the open draft's current shape into the entries cache (labels, History, tab titles). */
  const syncEntry = (id: string): void => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, data: { ...draftRef.current } } : e)));
  };

  /**
   * THE switch routine (handoff §6): every focus change — tab click, History row, `[+]`, close,
   * delete fallback, duplicate, New Task nonce — goes through here. Flushes the pending save of
   * the draft being left (a deleted draft's timer was already discarded, so a delete can't
   * resurrect), resets the create UI, ensures the target has a tab, and loads it synchronously
   * from the entries cache (the app is the only writer of these files — no async read to race).
   * Never called with an unreadable id: those rows are delete-only and cannot open.
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
      draftRef.current = emptyDraft();
      setBody('');
      setArchived(false);
      setCreated(null);
      setModel(undefined);
      dispatch({ type: 'reset' });
      return;
    }
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    clearUnseen(id);
    const entry = entriesRef.current.find((e) => e.id === id);
    if (entry?.data === undefined) {
      // Defensive only (call sites filter unreadable ids): fall back to a fresh draft rather
      // than render a file we cannot trust.
      switchRef.current(null);
      return;
    }
    draftRef.current = { ...entry.data };
    setBody(entry.data.body);
    setArchived(entry.data.archived);
    setCreated(entry.data.created ?? null);
    setModel(entry.data.chatModel);
    // Re-present as busy when this draft's completion is still in flight — its reply will land
    // through the id-keyed path, and a second send meanwhile must stay blocked.
    dispatch({ type: 'load', messages: entry.data.chat, busy: pendingTurns.current.has(id) });
  };
  const switchRef = useRef(switchTo);
  switchRef.current = switchTo;

  // Load the drafts once per mount, then pick the initial selection: a fresh conversation when
  // this mount was caused by a New Task click (unconsumed nonce), the remembered session
  // otherwise. Open tabs are filtered to drafts that still exist and still parse.
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
        // MERGE, don't replace (review #349 r7): the editor is live before this resolves, and a
        // draft minted in that window is not in the disk snapshot — replacing would drop it and
        // the switch below would yank it out from under the user's typing.
        const known = new Set(loaded.map((e) => e.id));
        const merged = [...entriesRef.current.filter((e) => !known.has(e.id)), ...loaded];
        setEntries(merged);
        entriesRef.current = merged;
        const readable = new Set(merged.filter((e) => e.data !== undefined).map((e) => e.id));
        setOpenTabs((prev) => prev.filter((id) => readable.has(id)));
        sessionReady.current = true;
        if (activeIdRef.current !== null) {
          // The user already minted a draft this mount — their selection wins; just consume the
          // nonce so a later prop change still resets.
          consumedNonce.value = freshNonce;
          return;
        }
        if (freshNonce !== consumedNonce.value) {
          consumedNonce.value = freshNonce;
          switchRef.current(null);
          setDrawerOpen(true);
          setPanel('chat');
        } else {
          const remembered = initialSession.current?.activeId ?? null;
          switchRef.current(remembered !== null && readable.has(remembered) ? remembered : null);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // A New Task click while already mounted resets to a fresh conversation — through the switch
  // routine — and presents the drawer. Skipped on the initial mount (review #349 r6): the async
  // loader above is the SOLE nonce authority there, so two consumers never race on consumedNonce.
  const nonceMounted = useRef(false);
  useEffect(() => {
    if (!nonceMounted.current) {
      nonceMounted.current = true;
      return;
    }
    if (freshNonce !== consumedNonce.value) {
      consumedNonce.value = freshNonce;
      switchRef.current(null);
      setDrawerOpen(true);
      setPanel('chat');
    }
  }, [freshNonce]);

  // Looking at the active conversation consumes its unseen mark.
  useEffect(() => {
    if (drawerOpen && panel === 'chat' && activeId !== null) clearUnseen(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen, panel, activeId]);

  // Close-flush (S10): window close awaits pending writes through the nav-guard flush hook.
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
    sessionReady.current = true;
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setEntries((prev) => [{ id, data: { ...draftRef.current } }, ...prev]);
    return id;
  };

  const onBodyChange = (next: string): void => {
    if (archived) return;
    setBody(next);
    draftRef.current = { ...draftRef.current, body: next };
    // Lazy creation: N clicks on New Task / `[+]` write zero files; the first non-empty edit
    // mints one.
    if (activeIdRef.current === null && next === '') return;
    const id = ensureId();
    syncEntry(id);
    writer.schedule(id, { ...draftRef.current });
  };

  const onModelChange = (next: string | undefined): void => {
    if (archived) return;
    setModel(next);
    draftRef.current = { ...draftRef.current, chatModel: next };
    // A model choice alone does not mint a file (handoff §4) — it rides draftRef until the first
    // edit/send carries it along.
    const id = activeIdRef.current;
    if (id === null) return;
    syncEntry(id);
    writer.schedule(id, { ...draftRef.current });
  };

  /** Inline tab rename (handoff §3). Empty name clears the override back to the derived label. */
  const rename = (id: string, raw: string): void => {
    const name = raw.trim().slice(0, 60);
    if (id === activeIdRef.current) {
      draftRef.current = { ...draftRef.current, name: name === '' ? undefined : name };
      syncEntry(id);
      void writer.writeNow(id, { ...draftRef.current });
      return;
    }
    // Inactive tab: the file is authoritative (its debounce was flushed on switch-away).
    void writer
      .update(id, (d) => ({ ...d, name: name === '' ? undefined : name }))
      .then((outcome) => {
        if (outcome !== 'written') return;
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id && e.data !== undefined
              ? { ...e, data: { ...e.data, name: name === '' ? undefined : name } }
              : e,
          ),
        );
      });
  };

  /**
   * LLM auto-title after the first exchange (handoff §3). Id-keyed and rename-safe: the active
   * path re-checks `name` on the live draft and writes through `writeNow` (superseding any armed
   * body debounce, which would otherwise land later WITHOUT the name and erase it); the inactive
   * path re-checks inside the read-modify-write, so a user rename that lands first wins. Failure
   * is silent — the derived label stands.
   */
  const generateTitle = (id: string, userText: string, reply: string, titleModel: string): void => {
    void apiComplete(project, {
      system: TITLE_PRESET,
      messages: [{ role: 'user', content: `${userText}\n\n${reply}`.slice(0, 4000) }],
      model: titleModel,
    })
      .then((res) => {
        const title = res.text
          ?.trim()
          .replace(/\s+/g, ' ')
          .replace(/^["'`]+|["'`.]+$/g, '')
          .slice(0, 60);
        if (title === undefined || title === '' || res.error !== undefined) return;
        if (id === activeIdRef.current) {
          if (draftRef.current.name !== undefined) return;
          draftRef.current = { ...draftRef.current, name: title };
          syncEntry(id);
          void writer.writeNow(id, { ...draftRef.current });
          return;
        }
        void writer
          .update(id, (d) => (d.name === undefined ? { ...d, name: title } : d))
          .then((outcome) => {
            if (outcome !== 'written') return;
            setEntries((prev) =>
              prev.map((e) =>
                e.id === id && e.data !== undefined && e.data.name === undefined
                  ? { ...e, data: { ...e.data, name: title } }
                  : e,
              ),
            );
          });
      })
      .catch(() => {});
  };

  const send = (text: string): void => {
    if (archived) return;
    // Per-id single-in-flight: synchronous, so a double click cannot slip between renders, and a
    // draft switch cannot clear another draft's slot.
    if (activeIdRef.current !== null && pendingTurns.current.has(activeIdRef.current)) return;
    const id = ensureId();
    pendingTurns.current.add(id);
    setPendingIds(new Set(pendingTurns.current));
    const apiMessages = [...chat.messages, { role: 'user' as const, content: text }];
    // Snapshot body AND model SYNCHRONOUSLY, like apiMessages (review #349 r5 blocking): the
    // .then below runs after an IPC round-trip, and a draft switch in that window repoints
    // draftRef — reading it late would send the newly opened draft's body (possibly secrets) as
    // this turn's <doc>, or its model as this turn's model.
    const bodyAtSend = draftRef.current.body;
    const modelAtSend = draftRef.current.chatModel;
    // First exchange of an unnamed conversation ⇒ auto-title once the reply lands (handoff §3).
    const wantsTitle = draftRef.current.chat.length === 0 && draftRef.current.name === undefined;
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
          model: modelAtSend ?? cfg.chatModel ?? DEFAULT_CHAT_MODEL,
        }).then((res) => ({ res, resolvedModel: modelAtSend ?? cfg.chatModel ?? DEFAULT_CHAT_MODEL })),
      )
      .then(({ res, resolvedModel }) => {
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
          // The reply arrived where the user may not be looking — surface it on the tab/badge.
          markUnseen(id);
        } else {
          // Late reply after a draft switch: dropped from the visible transcript (the gen rule),
          // but appended to the file it was issued for — a persisted transcript must not end on a
          // dangling user turn. `update` skips a deleted file, so this can never resurrect one.
          void writer.update(id, (d) => ({ ...d, chat: [...d.chat, { role: 'assistant', content: reply }] }));
          setEntries((prev) =>
            prev.map((e) =>
              e.id === id && e.data !== undefined
                ? { ...e, data: { ...e.data, chat: [...e.data.chat, { role: 'assistant', content: reply }] } }
                : e,
            ),
          );
          markUnseen(id);
        }
        if (wantsTitle) generateTitle(id, text, reply, resolvedModel);
      })
      .catch((err: unknown) => {
        if (id === activeIdRef.current) dispatch({ type: 'fail', message: String(err) });
      })
      .finally(() => {
        pendingTurns.current.delete(id);
        setPendingIds(new Set(pendingTurns.current));
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
          if (outcome !== 'written' && !deletedIds.current.has(id)) {
            // 'skipped' here without a local delete means the read-modify-write couldn't see the
            // file (transient IO, corrupt parse) — on disk the draft is still re-filable.
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

  /** Close a tab: UI-only — the draft file is untouched (handoff §2). */
  const closeTab = (id: string): void => {
    const tabs = openTabsRef.current;
    const idx = tabs.indexOf(id);
    const next = tabs.filter((t) => t !== id);
    setOpenTabs(next);
    clearUnseen(id);
    if (id === activeIdRef.current) {
      // Focus the left neighbor, else the first remaining tab, else the fresh state. switchTo
      // flushes the closing draft's pending save.
      const target = idx > 0 ? (next[idx - 1] ?? null) : (next[0] ?? null);
      switchTo(target);
    }
  };

  const removeDraft = (id: string): void => {
    setDeleteArm(null);
    deletedIds.current.add(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setOpenTabs((prev) => prev.filter((t) => t !== id));
    clearUnseen(id);
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
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    // Stamped here too (not just at write): the History row renders this copy's time immediately.
    draftRef.current = {
      body: src.body,
      chat: [...src.chat],
      archived: false,
      ...(src.chatModel !== undefined ? { chatModel: src.chatModel } : {}),
      updatedAt: new Date().toISOString(),
    };
    setBody(src.body);
    setModel(src.chatModel);
    dispatch({ type: 'load', messages: src.chat });
    setEntries((prev) => [{ id, data: { ...draftRef.current } }, ...prev]);
    void writer.writeNow(id, { ...draftRef.current });
  };

  const entryLabel = (e: DraftEntry): string => (e.data === undefined ? `${e.id} (unreadable)` : draftLabel(e.data));

  const rows: HistoryRow[] = entries.map((e) => {
    const ms = e.data !== undefined ? Date.parse(e.data.updatedAt) : NaN;
    return {
      id: e.id,
      label: entryLabel(e),
      time: Number.isNaN(ms) ? null : relTime(ms),
      unreadable: e.data === undefined,
      archived: e.data?.archived === true,
    };
  });

  const tabs: DrawerTab[] = openTabs.flatMap((id) => {
    const e = entriesRef.current.find((en) => en.id === id);
    if (e?.data === undefined) return [];
    return [
      {
        id,
        label: draftLabel(e.data),
        dot: pendingIds.has(id) || unseen.has(id),
        archived: e.data.archived,
      },
    ];
  });

  const headerLabel = activeId === null && body === '' && chat.messages.length === 0 ? 'New task…' : draftLabel(draftRef.current);
  const updatedMs = Date.parse(draftRef.current.updatedAt);
  const activity = openTabs.some((id) => pendingIds.has(id) || unseen.has(id));

  const validation =
    source === undefined
      ? "Can't read the task source from app.json — set it in Settings."
      : titleTooLong
        ? `Heading is too long to use as a title (max ${MAX_TITLE_BYTES} bytes).`
        : tooBig
          ? `Too long to file (${bodyBytes} / ${MAX_BODY_BYTES} bytes).`
          : docTitle === undefined
            ? 'Add a `# heading` to name the task.'
            : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border pb-2">
        <h1 className="truncate text-lg font-semibold">{headerLabel}</h1>
        {archived && created !== null && (
          <a
            href={created.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded border border-border px-2 py-0.5 font-mono text-xs text-primary"
          >
            filed as #{created.id}
          </a>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {!Number.isNaN(updatedMs) && relTime(updatedMs)}
          {archived && ' · archived'}
        </span>
        {createError !== null && <span className="truncate text-xs text-destructive">{createError}</span>}
        {saveError !== null && <span className="truncate text-xs text-destructive">{saveError}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {archived && created !== null ? (
            <>
              <Button variant="outlined" color="secondary" onClick={onOpenBoard}>
                Open board
              </Button>
              <Button variant="outlined" color="secondary" onClick={() => duplicate(draftRef.current)}>
                Duplicate
              </Button>
            </>
          ) : (
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
            >
              Create task
            </Button>
          )}
          <Button
            variant="outlined"
            color="secondary"
            aria-expanded={drawerOpen}
            aria-label="toggle chat drawer"
            onClick={() => setDrawerOpen((v) => !v)}
            className="relative"
          >
            <MessageSquare size={14} className="mr-1" />
            Chat
            {!drawerOpen && activity && (
              <span aria-label="chat activity" className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </Button>
        </div>
      </div>
      {!archived && validation !== null && (body !== '' || activeId !== null) && (
        <p className="shrink-0 pt-1 text-xs text-muted-foreground">{validation}</p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 pt-3">
        <div className="min-w-0 flex-1" onBlur={() => void writer.flush()}>
          <div className="mx-auto h-full max-w-3xl">
            <DocEditor
              value={body}
              onChange={onBodyChange}
              // confirming/creating too (review #349 r4): a keystroke while the create is in
              // flight would arm an archived:false debounce that lands AFTER the archive write.
              readOnly={chat.pending !== undefined || archived || confirming || creating}
            />
          </div>
        </div>
        {/* Hidden, not unmounted: closing the drawer is visibility only (handoff §6) — the
            transcript scroll position and any unsent composer text must survive a toggle. */}
        <div className={drawerOpen ? 'flex min-h-0' : 'hidden'}>
          <TaskDrawer
            panel={panel}
            tabs={tabs}
            activeId={activeId}
            rows={rows}
            deleteArm={deleteArm}
            onShowHistory={() => setPanel('history')}
            onSelectTab={(id) => {
              setPanel('chat');
              if (id !== activeIdRef.current) switchTo(id);
              else clearUnseen(id);
            }}
            onCloseTab={closeTab}
            onNewTab={() => {
              setPanel('chat');
              if (activeIdRef.current !== null) switchTo(null);
            }}
            onRename={rename}
            onOpenRow={(id) => {
              setPanel('chat');
              if (id !== activeIdRef.current) switchTo(id);
            }}
            onArmDelete={setDeleteArm}
            onDelete={removeDraft}
          >
            <ChatPane
              state={chat}
              disabled={archived}
              model={model}
              modelOptions={modelOptions}
              defaultModel={defaultModel}
              onModelChange={onModelChange}
              onSend={send}
              onAccept={accept}
              onReject={() => dispatch({ type: 'reject' })}
            />
          </TaskDrawer>
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
