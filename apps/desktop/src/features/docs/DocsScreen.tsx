import { useCallback, useEffect, useReducer, useState } from 'react';
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

  const refresh = useCallback(() => void listDocs(project).then(setNames), [project]);
  useEffect(() => refresh(), [refresh]);

  const open = useCallback(
    (name: string) => {
      void readDoc(project, name).then((content) => {
        setActive(name);
        setDoc(content);
      });
    },
    [project],
  );

  const newDoc = useCallback(() => {
    const name = `note-${names.length + 1}.md`;
    void writeDoc(project, name, `# ${name.replace('.md', '')}\n\n`).then(() => {
      refresh();
      open(name);
    });
  }, [project, names.length, refresh, open]);

  const save = useCallback(() => {
    if (active !== undefined) void writeDoc(project, active, doc);
  }, [project, active, doc]);

  const send = useCallback(
    (text: string) => {
      const apiMessages = [...chat.messages, { role: 'user' as const, content: text }];
      dispatch({ type: 'send', text });
      void readAppConfig(project).then((cfg) =>
        apiComplete({
          system: `${PLAN_PRESET}\n\nThe current document is:\n<doc>${doc}</doc>`,
          messages: apiMessages,
          model: cfg.chatModel ?? DEFAULT_CHAT_MODEL,
          ...(cfg.chatBaseUrl !== undefined ? { baseUrl: cfg.chatBaseUrl } : {}),
        })
          .then((res) => {
            if (res.error !== undefined) dispatch({ type: 'fail', message: res.error.message });
            else dispatch({ type: 'reply', text: res.text ?? '' });
          })
          .catch((err: unknown) => dispatch({ type: 'fail', message: String(err) })),
      );
    },
    [chat.messages, doc, project],
  );

  const accept = useCallback(() => {
    if (chat.pending === undefined) return;
    const next = chat.pending;
    setDoc(next);
    dispatch({ type: 'acceptApplied' });
    if (active !== undefined) void writeDoc(project, active, next);
  }, [chat.pending, active, project]);

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
