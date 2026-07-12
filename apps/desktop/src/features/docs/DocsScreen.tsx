import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@/ui';
import { apiComplete, listDocs, readDoc, writeDoc, readAppConfig } from '../../ipc.js';
import { DocEditor } from './DocEditor.js';
import { ChatPane } from './ChatPane.js';
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

  const refresh = useCallback(
    () => void listDocs(project).then(setNames).catch(() => setNames([])),
    [project],
  );
  useEffect(() => refresh(), [refresh]);

  // Plain closures (recreated each render): nothing downstream is memoized, and fresh closures avoid
  // stale-dep hazards. Only `refresh` needs a stable identity (it's a useEffect dep).
  const open = (name: string): void => {
    if (name === active) return; // re-clicking the open doc must not wipe an in-progress chat
    gen.current++; // invalidate any in-flight completion for the doc we're leaving
    void readDoc(project, name)
      .then((content) => {
        // Reset chat only once the new doc is loaded: the transcript + pending proposal belong to
        // the doc we left, and accept must never apply one doc's proposal to another.
        setActive(name);
        setDoc(content);
        dispatch({ type: 'reset' });
      })
      .catch((err: unknown) => dispatch({ type: 'fail', message: `open failed: ${String(err)}` }));
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
    const apiMessages = [...chat.messages, { role: 'user' as const, content: text }];
    const issued = gen.current; // the doc this turn was issued for
    dispatch({ type: 'send', text });
    void readAppConfig(project)
      .then((cfg) =>
        apiComplete({
          system: `${PLAN_PRESET}\n\nThe current document is:\n<doc>${doc}</doc>`,
          messages: apiMessages,
          model: cfg.chatModel ?? DEFAULT_CHAT_MODEL,
          ...(cfg.chatBaseUrl !== undefined && cfg.chatBaseUrl !== null ? { baseUrl: cfg.chatBaseUrl } : {}),
        }),
      )
      .then((res) => {
        if (issued !== gen.current) return; // switched docs mid-flight — this reply is for another doc
        if (res.error !== undefined) dispatch({ type: 'fail', message: res.error.message });
        else dispatch({ type: 'reply', text: res.text ?? '' });
      })
      .catch((err: unknown) => {
        if (issued === gen.current) dispatch({ type: 'fail', message: String(err) });
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
      <div className="w-80 shrink-0 border-l border-border pl-3">
        <ChatPane state={chat} onSend={send} onAccept={accept} onReject={() => dispatch({ type: 'reject' })} />
      </div>
    </div>
  );
}
