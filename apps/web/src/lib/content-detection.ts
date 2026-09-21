import type { MeshObjectType } from "@screenmesh/protocol";

export type ContentFacet = "links" | "code" | "checklists" | "documents";

export interface ContentEntities {
  urls: string[];
  emails: string[];
  ips: string[];
}

export interface ContentDetection {
  /** The safe primary object type to create when the composer is set to Auto. */
  primaryType: MeshObjectType;
  /** Search facets may overlap: a note can contain ordinary text and links. */
  facets: ContentFacet[];
  label: string;
  urls: string[];
  /** Deterministic entity extraction, for future faceted search/filtering. */
  entities: ContentEntities;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]+/gi;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IPV4_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

const CODE_FENCE_PATTERN = /```[\s\S]*?```/;
const CODE_LINE_PATTERN = /(^|\n)\s*(?:const|let|var|function|class|import|export|def|SELECT|INSERT|<\/?[A-Za-z][^>]*>)\b/m;
const CODE_SYMBOL_PATTERN = /[{};]|=>|\b(?:npm|pnpm|git|curl|docker)\s+\S+/;

// A genuine checklist has explicit "[ ]" / "[x]" boxes. Plain "-"/"*"/"1." bullets
// are extremely common in ordinary markdown notes and must not be enough on their
// own — that was misclassifying whole markdown documents (headings, quotes, bullet
// lists) as checklists and exploding every line into a checkbox item.
const CHECKBOX_LINE_PATTERN = /^\s*(?:[-*+]\s+)?\[\s?[xX]?\s?\]\s+\S/m;
const BULLET_LINE_PATTERN = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/m;

// Structural markdown signals: headings, fenced code, blockquotes, tables, bold
// text, and inline links. Any of these mean "formatted document", not "flat list".
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+\S/m;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s+\S/m;
const TABLE_ROW_PATTERN = /^\s{0,3}\|.+\|\s*$/m;
const BOLD_OR_LINK_PATTERN = /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/;

function urlsIn(text: string): string[] {
  return Array.from(text.matchAll(URL_PATTERN), (match) => match[0]!.replace(/[.,!?;:]+$/, ""));
}

function emailsIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(EMAIL_PATTERN), (match) => match[0]!)));
}

function ipsIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(IPV4_PATTERN), (match) => match[0]!)));
}

function hasMarkdownStructure(text: string): boolean {
  return (
    HEADING_PATTERN.test(text) ||
    CODE_FENCE_PATTERN.test(text) ||
    BLOCKQUOTE_PATTERN.test(text) ||
    TABLE_ROW_PATTERN.test(text) ||
    BOLD_OR_LINK_PATTERN.test(text)
  );
}

function looksLikeJson(text: string): boolean {
  if (!/^[[{]/.test(text) || !/[\]}]$/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A checklist only when it has explicit checkbox syntax, or — as a fallback for
 * quickly-typed task lists — plain bullets with no surrounding markdown structure
 * (headings, quotes, tables, bold/links, fenced code) and no long-document shape.
 */
function looksLikeChecklist(text: string): boolean {
  const lines = text.split("\n");
  if (lines.filter((line) => CHECKBOX_LINE_PATTERN.test(line)).length >= 1) return true;
  if (hasMarkdownStructure(text)) return false;
  const nonEmpty = lines.filter((line) => line.trim()).length;
  if (nonEmpty > 12) return false;
  const bulletLines = lines.filter((line) => BULLET_LINE_PATTERN.test(line)).length;
  return bulletLines >= 2 && bulletLines === nonEmpty;
}

function looksLikeCode(text: string): boolean {
  if (CODE_FENCE_PATTERN.test(text)) return true;
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return lines >= 2 && CODE_LINE_PATTERN.test(text) && CODE_SYMBOL_PATTERN.test(text);
}

function looksLikeDocument(text: string): boolean {
  if (hasMarkdownStructure(text)) return true;
  return text.split("\n").filter((line) => line.trim()).length >= 5 && text.trim().length >= 500;
}

/**
 * Classifies text locally with a deterministic detector pipeline (no AI, no
 * network call). Every signal below is a plain parser or pattern match, and
 * callers can always override the primary-type suggestion.
 */
export function detectContent(text: string): ContentDetection {
  const trimmed = text.trim();
  const urls = urlsIn(trimmed);
  const entities: ContentEntities = { urls, emails: emailsIn(trimmed), ips: ipsIn(trimmed) };

  const json = looksLikeJson(trimmed);
  const markdown = hasMarkdownStructure(trimmed);
  const checklist = looksLikeChecklist(trimmed);
  const code = json || looksLikeCode(trimmed);
  const document = looksLikeDocument(trimmed);

  const facets: ContentFacet[] = [
    ...(urls.length ? ["links" as const] : []),
    ...(code ? ["code" as const] : []),
    ...(checklist ? ["checklists" as const] : []),
    ...(document ? ["documents" as const] : []),
  ];

  // Priority: a formatted markdown/JSON document wins over a bare "contains a
  // link/bullet" signal, so a doc full of headings and links isn't reduced to a
  // Link or Checklist object. A short message that's basically just a URL still
  // becomes a Link. Explicit checklists beat a generic code/document guess.
  if (document && (markdown || json)) return { primaryType: "document", facets, label: "Document", urls, entities };
  if (checklist) return { primaryType: "checklist", facets, label: "Checklist", urls, entities };
  if (urls.length) return { primaryType: "link", facets, label: "Link", urls, entities };
  if (code) return { primaryType: "code", facets, label: json ? "JSON" : "Code snippet", urls, entities };
  if (document) return { primaryType: "document", facets, label: "Document", urls, entities };
  return { primaryType: "text", facets, label: "Text", urls, entities };
}
