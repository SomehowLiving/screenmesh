import { Fragment, type ReactNode } from "react";

/**
 * A small, dependency-free markdown renderer: headings, bold/italic, inline
 * code, links, blockquotes, lists, fenced code, and tables. It never uses
 * dangerouslySetInnerHTML — everything is built as React elements, and link
 * hrefs are restricted to safe schemes, so pasted content can't inject HTML
 * or script URLs. Deliberately not a full CommonMark implementation: this
 * only needs to make the Library's own detector output look right.
 */

const SAFE_LINK_PATTERN = /^(https?:\/\/|mailto:|www\.)/i;
const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|(?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))|(\[[^\]\n]+\]\([^)\n]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const [whole, code, bold, italic, link] = match;
    const key = `${keyPrefix}-${index++}`;
    if (code) nodes.push(<code key={key} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">{code.slice(1, -1)}</code>);
    else if (bold) nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
    else if (italic) nodes.push(<em key={key}>{italic.slice(1, -1)}</em>);
    else if (link) {
      const closeBracket = link.indexOf("](");
      const label = link.slice(1, closeBracket);
      const href = link.slice(closeBracket + 2, -1);
      nodes.push(
        SAFE_LINK_PATTERN.test(href)
          ? <a key={key} href={href.startsWith("www.") ? `https://${href}` : href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{label}</a>
          : whole,
      );
    }
    lastIndex = match.index + whole.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderBlock(block: string, key: string): ReactNode {
  if (block.startsWith("```")) {
    const lines = block.split("\n");
    const code = lines.slice(1, lines[lines.length - 1]?.trim() === "```" ? -1 : undefined).join("\n");
    return <pre key={key} className="overflow-x-auto rounded-xl bg-foreground p-4 text-xs leading-6 text-primary-foreground"><code>{code}</code></pre>;
  }

  const lines = block.split("\n");
  const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
  if (heading && lines.length === 1) {
    const level = heading[1]!.length;
    const Tag = (`h${Math.min(level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
    const sizes: Record<string, string> = { h2: "text-xl font-semibold", h3: "text-lg font-semibold", h4: "text-base font-semibold", h5: "text-sm font-semibold", h6: "text-sm font-medium" };
    return <Tag key={key} className={`${sizes[Tag]} mt-1`}>{renderInline(heading[2] ?? "", key)}</Tag>;
  }

  if (lines.every((line) => /^\s{0,3}>\s?/.test(line))) {
    const quoted = lines.map((line) => line.replace(/^\s{0,3}>\s?/, "")).join("\n");
    return <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">{renderInline(quoted, key)}</blockquote>;
  }

  if (lines.length >= 2 && lines[0]?.includes("|") && isTableSeparator(lines[1] ?? "")) {
    const header = splitTableRow(lines[0]!);
    const rows = lines.slice(2).map(splitTableRow);
    return (
      <table key={key} className="w-full border-collapse text-sm">
        <thead><tr>{header.map((cell, i) => <th key={i} className="border-b border-border px-2 py-1 text-left font-medium">{renderInline(cell, `${key}-h${i}`)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className="border-b border-border/60 px-2 py-1">{renderInline(cell, `${key}-${r}-${c}`)}</td>)}</tr>)}</tbody>
      </table>
    );
  }

  const bulletMatch = (line: string) => /^\s*[-*+]\s+(.*)$/.exec(line);
  const orderedMatch = (line: string) => /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (lines.every((line) => bulletMatch(line))) {
    return <ul key={key} className="list-disc space-y-1 pl-5">{lines.map((line, i) => <li key={i}>{renderInline(bulletMatch(line)![1]!, `${key}-${i}`)}</li>)}</ul>;
  }
  if (lines.every((line) => orderedMatch(line))) {
    return <ol key={key} className="list-decimal space-y-1 pl-5">{lines.map((line, i) => <li key={i}>{renderInline(orderedMatch(line)![1]!, `${key}-${i}`)}</li>)}</ol>;
  }

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(block)) return <hr key={key} className="border-border" />;

  return <p key={key} className="whitespace-pre-wrap break-words">{renderInline(block, key)}</p>;
}

export function Markdown(props: { text: string; className?: string }) {
  const blocks: string[] = [];
  let inFence = false;
  let current: string[] = [];
  for (const line of props.text.split("\n")) {
    if (/^```/.test(line.trim())) {
      current.push(line);
      if (inFence) { blocks.push(current.join("\n")); current = []; }
      inFence = !inFence;
      continue;
    }
    if (inFence) { current.push(line); continue; }
    if (line.trim() === "") {
      if (current.length) { blocks.push(current.join("\n")); current = []; }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));

  return (
    <div className={`space-y-3 text-sm leading-6 ${props.className ?? ""}`}>
      {blocks.map((block, i) => <Fragment key={i}>{renderBlock(block, `b${i}`)}</Fragment>)}
    </div>
  );
}
