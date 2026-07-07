import type { ReactNode } from 'react';
import { Chip } from 'chunks-ui';
import { Markdown } from './Markdown';
import { Callout } from './Callout';

// Matches a balanced `<tag>…</tag>` block (tag = word). Agents emit <plan>, <findings>, <promise>, …
const TAG_RE = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

/** Render agent output: known `<tag>…</tag>` blocks become styled callouts; the rest is markdown. */
export function AgentText({ children }: { children: string }) {
  const src = children;
  const parts: ReactNode[] = [];
  const re = new RegExp(TAG_RE);
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const pre = src.slice(last, m.index).trim();
      if (pre) parts.push(<Markdown key={key++}>{pre}</Markdown>);
    }
    const tag = m[1];
    const inner = m[2].trim();
    if (!inner.includes('\n') && inner.length <= 40) {
      parts.push(
        <div key={key++} className="my-2">
          <Chip color="secondary" variant="outlined">
            {tag}: {inner}
          </Chip>
        </div>,
      );
    } else {
      parts.push(
        <Callout key={key++} label={tag}>
          <Markdown>{inner}</Markdown>
        </Callout>,
      );
    }
    last = m.index + m[0].length;
  }

  if (last < src.length) {
    const rest = src.slice(last).trim();
    if (rest) parts.push(<Markdown key={key++}>{rest}</Markdown>);
  }

  if (parts.length === 0) return <Markdown>{src}</Markdown>;
  return <>{parts}</>;
}
