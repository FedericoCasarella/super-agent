import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Props = {
  content: string;
  onWikilinkClick?: (target: string) => void;
};

// Convert [[wikilinks]] to markdown links with a custom scheme our renderer intercepts
function transformWikilinks(src: string): string {
  return src.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => {
    const label = (alias ?? target).trim();
    return `[${label}](wikilink:${encodeURIComponent(target.trim())})`;
  });
}

// Strip a YAML frontmatter block at the start if present. Backend should
// already do this via gray-matter, but agent-generated notes occasionally
// have leading whitespace / BOM that defeat matter() parsing — clean here.
function stripFrontmatter(src: string): string {
  const m = src.match(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? src.slice(m[0].length) : src;
}

export default function MarkdownView({ content, onWikilinkClick }: Props) {
  const md = transformWikilinks(stripFrontmatter(content ?? ''));
  return (
    <div className="prose-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          a({ href, children }) {
            if (href?.startsWith('wikilink:')) {
              const target = decodeURIComponent(href.slice(9));
              return (
                <button
                  type="button"
                  className="text-accent2 hover:underline"
                  onClick={() => onWikilinkClick?.(target)}
                >
                  {children}
                </button>
              );
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent2 hover:underline">{children}</a>;
          },
          h1: ({ children }) => <h1 className="text-xl font-semibold mt-4 mb-2 text-text">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-semibold mt-4 mb-2 text-text">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold mt-3 mb-1.5 text-text">{children}</h3>,
          p: ({ children }) => <p className="text-sm leading-relaxed text-text/90 my-2">{children}</p>,
          ul: ({ children }) => <ul className="list-disc list-inside text-sm text-text/90 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal list-inside text-sm text-text/90 my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-sm">{children}</li>,
          strong: ({ children }) => <strong className="text-text font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic text-text/90">{children}</em>,
          code: ({ children }) => <code className="font-mono text-xs bg-surface2 border border-border rounded px-1.5 py-0.5">{children}</code>,
          pre: ({ children }) => <pre className="font-mono text-xs bg-surface2 border border-border rounded-lg p-3 overflow-x-auto my-3">{children}</pre>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-accent/40 pl-3 text-muted my-2">{children}</blockquote>,
          hr: () => <hr className="border-border my-4" />,
          table: ({ children }) => <table className="text-sm border border-border rounded my-2">{children}</table>,
          th: ({ children }) => <th className="border-b border-border px-2 py-1 text-left text-muted">{children}</th>,
          td: ({ children }) => <td className="border-b border-border/40 px-2 py-1">{children}</td>,
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}
