/** Pure chat state for the doc editor's sidebar. `pending !== undefined` ⇒ a whole-doc proposal is
 * awaiting accept/reject, and the editor must be read-only so a stray edit can't be silently eaten. */

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface DocChatState {
  messages: ChatMsg[];
  /** The proposed replacement doc, if the last assistant reply contained a <doc> block. */
  pending?: string;
  busy: boolean;
  error?: string;
}

export type DocChatAction =
  | { type: 'send'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'acceptApplied' }
  | { type: 'reject' }
  | { type: 'fail'; message: string }
  | { type: 'reset' }
  // Seed a persisted transcript on draft open (S10). Never restores `pending`: the accept/reject
  // affordance is session-only, but the raw reply (its <doc> block included) is in `messages`.
  // `busy` re-presents an in-flight completion for THIS draft (per-id guard, review #349 r1).
  | { type: 'load'; messages: ChatMsg[]; busy?: boolean };

export const initialDocChat = (): DocChatState => ({ messages: [], busy: false });

/** Split an assistant reply into the prose note (shown as the message) and an optional <doc> body. */
export function extractDoc(text: string): { note: string; doc?: string } {
  // Greedy: match to the LAST </doc> so a doc body that itself mentions the sentinel (the model is
  // told to use <doc> tags) isn't silently truncated at an inner close.
  const m = /<doc>([\s\S]*)<\/doc>/.exec(text);
  if (m === null) return { note: text.trim() };
  const doc = m[1] ?? '';
  const note = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { note, doc };
}

export function reduceDocChat(state: DocChatState, action: DocChatAction): DocChatState {
  switch (action.type) {
    case 'send':
      if (state.busy) return state; // one turn in flight at a time; a stale reply can't clobber a newer one
      return {
        ...state,
        messages: [...state.messages, { role: 'user', content: action.text }],
        busy: true,
        error: undefined,
      };
    case 'reset':
      // Chat is doc-specific context; switching docs must drop the transcript AND any pending
      // proposal so an accept can never write one doc's proposal into another.
      return initialDocChat();
    case 'reply': {
      // Store the RAW reply, <doc> block included: the transcript persists to disk now (S10), and
      // storing the "(proposed a document revision)" placeholder would destroy the model's primary
      // output on relaunch. Display derivation lives in ChatMessage.
      const { doc } = extractDoc(action.text);
      return {
        ...state,
        messages: [...state.messages, { role: 'assistant', content: action.text }],
        busy: false,
        ...(doc !== undefined ? { pending: doc } : {}),
      };
    }
    case 'load':
      return { messages: action.messages, busy: action.busy === true };
    case 'acceptApplied':
    case 'reject':
      return { ...state, pending: undefined };
    case 'fail':
      return { ...state, busy: false, error: action.message };
  }
}
