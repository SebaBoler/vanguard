import { Markdown } from '@/ui';
import { extractDoc, type ChatMsg } from './useDocChat.js';

/**
 * One chat bubble: user text verbatim, assistant text through the shared Markdown renderer.
 * Assistant replies are STORED raw (the persisted transcript must keep a proposal's <doc> body,
 * S10) — the "(proposed a document revision)" placeholder is derived here, at render time.
 */
export function ChatMessage({ msg }: { msg: ChatMsg }) {
  if (msg.role === 'user') {
    return (
      <div className="ml-6 rounded-lg bg-muted/40 px-3 py-2 text-sm">
        <p className="whitespace-pre-wrap">{msg.content}</p>
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
