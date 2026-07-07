import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

/** Render agent markdown (headers, lists, bold, fenced code/JSON). Enhance later. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-code:before:content-none prose-code:after:content-none prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Unwrap <pre> so a fenced block renders exactly one CodeBlock (which has its own <pre>).
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            const text = String(children).replace(/\n$/, '');
            if (!lang && !text.includes('\n')) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]" {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock code={text} lang={lang} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
