export interface StreamEntry {
  role: 'assistant' | 'tool' | 'tool_result' | 'result';
  text: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toolLabel(b: any): string {
  const name = typeof b.name === 'string' ? b.name : 'tool';
  const inp = b.input ?? {};
  const hintRaw = inp.file_path ?? inp.path ?? inp.command ?? inp.pattern ?? inp.description ?? inp.prompt;
  const hint = typeof hintRaw === 'string' ? hintRaw.replace(/\s+/g, ' ').slice(0, 80) : '';
  return hint ? `${name} · ${hint}` : name;
}

function resultText(content: any): string {
  const s =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join(' ')
        : '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Parse an agent stream-json transcript (Claude Code `--output-format stream-json` stdout). */
export function parseAgentStream(raw: string): StreamEntry[] {
  const out: StreamEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ role: 'assistant', text: b.text });
        } else if (b.type === 'tool_use') {
          out.push({ role: 'tool', text: toolLabel(b) });
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_result') {
          const s = resultText(b.content);
          if (s) out.push({ role: 'tool_result', text: s });
        }
      }
    } else if (msg.type === 'result') {
      const cost = typeof msg.total_cost_usd === 'number' ? ` · $${msg.total_cost_usd.toFixed(2)}` : '';
      out.push({ role: 'result', text: `${msg.subtype ?? 'result'}${cost}` });
    }
  }
  return out;
}
