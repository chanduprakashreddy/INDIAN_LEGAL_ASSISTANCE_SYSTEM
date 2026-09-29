import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Renders inline bold, italics, code and [1] citation chips. */
function inline(text: string, onCitation?: (index: number) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[\d{1,2}\])/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    key += 1;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const index = Number(token.slice(1, -1));
      nodes.push(
        <button
          key={key}
          type="button"
          onClick={() => onCitation?.(index)}
          className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brass/25 px-1.5 align-baseline text-[11px] font-semibold text-brass-foreground transition-colors hover:bg-brass/45"
          aria-label={`Open source ${index}`}
        >
          {index}
        </button>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function MarkdownText({
  content,
  className,
  onCitation,
}: {
  content: string;
  className?: string;
  onCitation?: (index: number) => void;
}) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item, onCitation)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length}>{items}</ol>
      ) : (
        <ul key={blocks.length}>{items}</ul>
      ),
    );
    list = null;
  };

  lines.forEach((raw) => {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      flushList();
      const level = (heading[1] ?? "#").length;
      const text = inline(heading[2] ?? "", onCitation);
      blocks.push(
        level <= 2 ? (
          <h3 key={blocks.length}>{text}</h3>
        ) : (
          <h4 key={blocks.length} className="font-semibold">
            {text}
          </h4>
        ),
      );
      return;
    }
    if (bullet) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1] ?? "");
      return;
    }
    if (ordered) {
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1] ?? "");
      return;
    }
    flushList();
    if (!line.trim()) return;
    blocks.push(<p key={blocks.length}>{inline(line, onCitation)}</p>);
  });
  flushList();

  return (
    <div className={cn("prose-legal text-sm", className)}>
      {blocks.map((block, index) => (
        <Fragment key={index}>{block}</Fragment>
      ))}
    </div>
  );
}
