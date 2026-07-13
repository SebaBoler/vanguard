import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@/ui';
import { apiComplete, apiCreateTask, listDocs, readDoc, writeDoc, readAppConfig } from '../../ipc.js';
import { DocEditor } from './DocEditor.js';
import { ChatPane } from './ChatPane.js';
import { CreateTaskDialog } from './CreateTaskDialog.js';
import { titleFromDoc } from './docTask.js';
import { reduceDocChat, initialDocChat } from './useDocChat.js';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-5';

/** System prompt for the idea→plan preset. It is a chat preset, NOT the sandboxed `planner` stage. */
const PLAN_PRESET =
  'You help turn a rough idea into a clear implementation plan. Reply conversationally. When you ' +
  'propose changes to the document, return the ENTIRE revised document verbatim inside <doc>...</doc> ' +
  'tags (put any commentary OUTSIDE the tags). If you are only answering a question, omit the tags.';

/** Docs screen: doc list + CodeMirror editor + sidebar chat that proposes whole-doc edits. */
export function DocsScreen({ project }: { project: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [doc, setDoc] = useState('');
  const [chat, dispatch] = useReducer(reduceDocChat, undefined, initialDocChat);
  // Bumped on every doc switch; an in-flight completion whose generation is stale is dropped so a
  // reply for the doc we LEFT can never land on (and be accepted into) the doc we switched to.
  const gen = useRef(0);
  // The chat turn currently in flight (0 = none). A ref, not `chat.busy`, because it must be readable
  // synchronously within one tick — see `send`. `turnSeq` only mints the ids.
  const inFlight = useRef(0);
  const turnSeq = useRef(0);
  // Create-task: the confirm dialog, the result, and a ref guard. A ref, not state, because a double
  // click before the next render would create TWO REAL ISSUES — S3's double-send bug, except this one
  // cannot be undone. `creating` is only for the spinner.
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [source, setSource] = useState('github');
  const createInFlight = useRef(false);

  useEffect(() => {
    void readAppConfig(project)
      .then((cfg) => setSource(cfg.source ?? 'github'))
      .catch(() => setSource('github'));
  }, [project]);

  const refresh = useCallback(
    () => void listDocs(project).then(setNames).catch(() => setNames([])),
    [project],
  );
  useEffect(() => refresh(), [refresh]);

  // Plain closures (recreated each render): nothing downstream is memoized, and fresh closures avoid
  // stale-dep hazards. Only `refresh` needs a stable identity (it's a useEffect dep).
  const open = (name: string): void => {
    if (name === active) return; // re-clicking the open doc must not wipe an in-progress chat
    const issued = ++gen.current; // invalidate any in-flight completion for the doc we're leaving
    // The `reset` below clears `chat.busy`, so the in-flight slot must be released with it or the new
    // doc's chat would be permanently unable to send. The abandoned turn's `.finally` sees a different
    // id and leaves the slot alone.
    inFlight.current = 0;
    void readDoc(project, name)
      .then((content) => {
        // Same generation guard the completion path uses: on a fast B→C switch readDoc(C) can resolve
        // before readDoc(B), and without this the later-landing B would overwrite the doc the user
        // actually clicked. Name and content are set together, so the view stays self-consistent —
        // it would just be showing the wrong document.
        if (issued !== gen.current) return;
        // Reset chat only once the new doc is loaded: the transcript + pending proposal belong to
        // the doc we left, and accept must never apply one doc's proposal to another.
        setActive(name);
        setDoc(content);
        dispatch({ type: 'reset' });
      })
      .catch((err: unknown) => {
        if (issued === gen.current) dispatch({ type: 'fail', message: `open failed: ${String(err)}` });
      });
  };

  const newDoc = (): void => {
    // First free note-N so a numbering gap (deleted/renamed doc) can't overwrite a live file.
    let n = 1;
    while (names.includes(`note-${n}.md`)) n++;
    const name = `note-${n}.md`;
    void writeDoc(project, name, `# note-${n}\n\n`)
      .then(() => {
        refresh();
        open(name);
      })
      .catch((err: unknown) => dispatch({ type: 'fail', message: `create failed: ${String(err)}` }));
  };

  const save = (): void => {
    // Never save while a proposal is pending — the editor shows the old doc read-only, and an accept
    // is about to write the new one; a blur-save here would clobber it with stale content.
    if (active === undefined || chat.pending !== undefined) return;
    void writeDoc(project, active, doc).catch((err: unknown) =>
      dispatch({ type: 'fail', message: `save failed: ${String(err)}` }),
    );
  };

  const send = (text: string): void => {
    // `chat.busy` (and the disabled Send button) only reflect the dispatch on the NEXT render, so a
    // fast double-click fires two apiComplete calls before either is visible. The reducer no-ops the
    // second `send`, so the transcript is fine — but two requests go out and both replies dispatch.
    // A ref updates synchronously, so it closes the window the reducer state cannot.
    if (inFlight.current !== 0) return;
    const turn = ++turnSeq.current;
    inFlight.current = turn;

    const apiMessages = [...chat.messages, { role: 'user' as const, content: text }];
    const issued = gen.current; // the doc this turn was issued for
    dispatch({ type: 'send', text });
    // chatBaseUrl is deliberately NOT forwarded: Rust reads it from app.json itself, so the webview
    // cannot pick where the inherited Anthropic credential gets sent. See CompleteParams in ipc.ts.
    void readAppConfig(project)
      .then((cfg) =>
        apiComplete(project, {
          system: `${PLAN_PRESET}\n\nThe current document is:\n<doc>${doc}</doc>`,
          messages: apiMessages,
          model: cfg.chatModel ?? DEFAULT_CHAT_MODEL,
        }),
      )
      .then((res) => {
        if (issued !== gen.current) return; // switched docs mid-flight — this reply is for another doc
        if (res.error !== undefined) dispatch({ type: 'fail', message: res.error.message });
        else dispatch({ type: 'reply', text: res.text ?? '' });
      })
      .catch((err: unknown) => {
        if (issued === gen.current) dispatch({ type: 'fail', message: String(err) });
      })
      .finally(() => {
        // Only the turn that still owns the slot may release it: a doc switch clears it eagerly (see
        // `open`), and a stale turn settling afterwards must not free a newer turn's slot.
        if (inFlight.current === turn) inFlight.current = 0;
      });
  };

  const docTitle = titleFromDoc(doc);

  const createTask = (): void => {
    if (createInFlight.current || active === undefined || docTitle === undefined) return;
    createInFlight.current = true;
    setCreating(true);
    void apiCreateTask(project, docTitle, doc)
      .then((task) => {
        setCreated(task);
        setConfirming(false);
      })
      .catch((err: unknown) => dispatch({ type: 'fail', message: `create task failed: ${String(err)}` }))
      .finally(() => {
        createInFlight.current = false;
        setCreating(false);
      });
  };

  const accept = (): void => {
    if (chat.pending === undefined) return;
    const next = chat.pending;
    setDoc(next);
    dispatch({ type: 'acceptApplied' });
    if (active !== undefined) {
      void writeDoc(project, active, next).catch((err: unknown) =>
        dispatch({ type: 'fail', message: `save failed: ${String(err)}` }),
      );
    }
  };

  return (
    <div className="flex h-full gap-3">
      <div className="w-48 shrink-0 space-y-1 overflow-auto border-r border-border pr-2">
        <Button onClick={newDoc} className="w-full">
          New doc
        </Button>
        {names.map((n) => (
          <button
            key={n}
            onClick={() => open(n)}
            className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${n === active ? 'bg-muted/40' : 'hover:bg-muted/20'}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex-1" onBlur={save}>
        {active !== undefined ? (
          <DocEditor value={doc} onChange={setDoc} readOnly={chat.pending !== undefined} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Select or create a doc.</p>
        )}
      </div>
      <div className="flex w-80 shrink-0 flex-col gap-2 border-l border-border pl-3">
        <div className="shrink-0">
          <Button
            onClick={() => setConfirming(true)}
            disabled={active === undefined || docTitle === undefined || chat.pending !== undefined}
            className="w-full"
          >
            Create task
          </Button>
          {active !== undefined && docTitle === undefined && (
            // Refuse rather than invent a title: a filename fallback would create a real, un-deletable
            // issue called `note-3.md`.
            <p className="mt-1 text-xs text-muted-foreground">Add a `# heading` to name the task.</p>
          )}
          {created !== null && (
            <p className="mt-1 truncate text-xs">
              Created{' '}
              <a href={created.url} target="_blank" rel="noreferrer" className="underline">
                {created.id}
              </a>
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <ChatPane state={chat} onSend={send} onAccept={accept} onReject={() => dispatch({ type: 'reject' })} />
        </div>
      </div>

      {confirming && docTitle !== undefined && (
        <CreateTaskDialog
          source={source}
          title={docTitle}
          bodyBytes={new TextEncoder().encode(doc).length}
          busy={creating}
          onConfirm={createTask}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
