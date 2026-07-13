import { Markdown } from '@/ui';
import type { ChatMsg } from './useDocChat.js';

/** One chat bubble: user text verbatim, assistant text through the shared Markdown renderer. */
export function ChatMessage({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${isUser ? 'ml-6 bg-muted/40' : 'mr-6 bg-muted/10'}`}>
      {isUser ? <p className="whitespace-pre-wrap">{msg.content}</p> : <Markdown>{msg.content}</Markdown>}
    </div>
  );
}
