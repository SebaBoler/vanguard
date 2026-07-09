import hljs from 'highlight.js/lib/common';

/** Dark editor-style code block. Pretty-prints JSON, syntax-highlights known languages. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  let display = code;
  if (lang === 'json') {
    try {
      display = JSON.stringify(JSON.parse(code), null, 2);
    } catch {
      // not valid JSON — show as-is
    }
  }
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
      {lang && (
        <span className="absolute right-2 top-2 z-10 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
          {lang}
        </span>
      )}
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
