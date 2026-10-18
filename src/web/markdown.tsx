import { memo, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface RenderMarkdownOptions {
  resolveImageUrl?: (src: string) => string | null;
  resolveReference?: (raw: string) => string | null;
  referenceMode?: boolean;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: { hProperties: { className: string } };
}

function references(options: RenderMarkdownOptions) {
  return () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (["link", "linkReference", "image", "imageReference", "code", "inlineCode", "html"].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const parts: MarkdownNode[] = [];
        const pattern = /(?<![\w/:#])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*(?![\w])/g;
        let offset = 0;
        for (const match of text.matchAll(pattern)) {
          const url = options.resolveReference?.(match[0]);
          if (!url || !defaultUrlTransform(url)) continue;
          parts.push({ type: "text", value: text.slice(offset, match.index) });
          parts.push({ type: "link", url, children: [{ type: "text", value: match[0] }], data: { hProperties: { className: "markdown-ref" } } });
          offset = match.index! + match[0].length;
        }
        parts.push({ type: "text", value: text.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}

const MarkdownContent = memo(function MarkdownContent({ source, options }: { source: string; options: RenderMarkdownOptions }) {
  return <ReactMarkdown
    remarkPlugins={options.referenceMode && options.resolveReference ? [remarkGfm, references(options)] : [remarkGfm]}
    urlTransform={(url, key) => {
      if (key === "src" && options.resolveImageUrl && url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) {
        return defaultUrlTransform(options.resolveImageUrl(url) ?? "");
      }
      return defaultUrlTransform(url);
    }}
    components={{
      img: ({ src, alt }) => src ? <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" /> : <span className="markdown-alt">{alt}</span>,
      a: ({ href, children, className }) => href ? <a href={href} className={className} rel="noreferrer">{children}</a> : <span className="markdown-broken-link">{children}</span>,
      pre: ({ children }) => <pre className="markdown-pre">{children}</pre>,
      code: ({ children, className }) => <code className={className ?? "markdown-inline-code"}>{children}</code>,
      table: ({ children }) => <div className="markdown-table-scroll" role="region" aria-label="Markdown table" tabIndex={0}><table>{children}</table></div>,
    }}
  >{source}</ReactMarkdown>;
}, (previous, next) => previous.source === next.source && previous.options.resolveImageUrl === next.options.resolveImageUrl && previous.options.resolveReference === next.options.resolveReference && previous.options.referenceMode === next.options.referenceMode);

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): ReactNode {
  return <MarkdownContent source={source} options={options} />;
}
