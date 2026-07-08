import { parseFindings, type Finding } from './findings';

export type AgentTextSegment =
  | { type: 'markdown'; text: string }
  | { type: 'chip'; tag: string; text: string }
  | { type: 'callout'; tag: string; text: string }
  | { type: 'findings'; tag: string; findings: Finding[] };

// Matches a balanced `<tag>…</tag>` block (tag = word). Agents emit <plan>, <findings>, <promise>, …
const TAG_RE = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

/** Splits agent output into typed segments: known `<tag>…</tag>` blocks (chip/callout/findings) and the markdown in between. Pure — no rendering. */
export function parseAgentText(src: string): AgentTextSegment[] {
  const segments: AgentTextSegment[] = [];
  const re = new RegExp(TAG_RE);
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const pre = src.slice(last, m.index).trim();
      if (pre) segments.push({ type: 'markdown', text: pre });
    }
    const tag = m[1];
    const inner = m[2].trim();
    const findings = tag === 'findings' ? parseFindings(inner) : null;
    if (findings) {
      segments.push({ type: 'findings', tag, findings });
    } else if (!inner.includes('\n') && inner.length <= 40) {
      segments.push({ type: 'chip', tag, text: inner });
    } else {
      segments.push({ type: 'callout', tag, text: inner });
    }
    last = m.index + m[0].length;
  }

  if (last < src.length) {
    const rest = src.slice(last).trim();
    if (rest) segments.push({ type: 'markdown', text: rest });
  }

  if (segments.length === 0) segments.push({ type: 'markdown', text: src });
  return segments;
}
