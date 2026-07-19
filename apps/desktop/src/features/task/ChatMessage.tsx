import { Pencil } from 'lucide-react';
import { Markdown } from '@/ui';
import { extractDoc, type ChatMsg } from './useDocChat.js';

/**
 * One chat bubble: user text verbatim, assistant text through the shared Markdown renderer.
 * Assistant replies are STORED raw (the persisted transcript must keep a proposal's <doc> body,
 * S10) — the "(proposed a document revision)" placeholder is derived here, at render time.
 *
 * `onEdit`, when present (the last user message), renders an edit affordance that truncates the
 * exchange and reloads the message into the composer for a regenerate (Editor UX 5/7).
 */
export function ChatMessage({ msg, onEdit }: { msg: ChatMsg; onEdit?: () => void }) {
  if (msg.role === 'user') {
    return (
      <div className="group relative ml-6 rounded-lg bg-muted/40 px-3 py-2 text-sm">
        <p className="whitespace-pre-wrap">{msg.content}</p>
        {onEdit !== undefined && (
          <button
            type="button"
            aria-label="edit message"
            onClick={onEdit}
            className="absolute -left-5 top-2 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
    );
  }
  const { note, doc } = extractDoc(msg.content);
  const shown = note !== '' ? note : doc !== undefined ? '(proposed a document revision)' : msg.content;
  return (
    <div className="mr-6 rounded-lg bg-muted/10 px-3 py-2 text-sm">
      <Markdown>{shown}</Markdown>
    </div>
  );
}
