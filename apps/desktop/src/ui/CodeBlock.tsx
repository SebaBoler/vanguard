import { useEffect, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';

/** Dark editor-style code block. Pretty-prints JSON, syntax-highlights known languages, and offers
 * a one-click copy of the shown text with a brief confirmation (Editor UX 5/7). */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  let display = code;
  if (lang === 'json') {
    try {
      display = JSON.stringify(JSON.parse(code), null, 2);
    } catch {
      // not valid JSON — show as-is
    }
  }
  const onCopy = (): void => {
    // Copy what's on screen (pretty-printed JSON included). `?.` guards a webview without the
    // Clipboard API and jsdom in tests; the confirmation only flips on a resolved write.
    void navigator.clipboard?.writeText(display).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    });
  };
  let html: string | null = null;
  if (lang && hljs.getLanguage(lang)) {
    try {
      // hljs.highlight() HTML-escapes the input and emits only <span class="hljs-*"> tokens — its
      // documented XSS-safe contract. So the dangerouslySetInnerHTML below is safe (no raw HTML from
      // `display` survives); the app's strict CSP is a further backstop.
      html = hljs.highlight(display, { language: lang, ignoreIllegals: true }).value;
    } catch {
      html = null;
    }
  }
  return (
    <div className="not-prose relative my-3">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        {lang && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            {lang}
          </span>
        )}
        <button
          type="button"
          onClick={onCopy}
          aria-label="copy code"
          className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 hover:bg-white/20"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-auto rounded-md border border-zinc-700/60 bg-[#0d1117] p-3 text-xs leading-relaxed text-zinc-100">
        {html ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{display}</code>
        )}
      </pre>
    </div>
  );
}
