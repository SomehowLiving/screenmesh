import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type {
  AgentTaskContent,
  ChecklistContent,
  FileContent,
  MeshObject,
  MeshObjectType,
  TextContent,
} from "@screenmesh/protocol";
import type { ObjectLocalState, ScreenMeshDb } from "@screenmesh/storage";
import { RETYPEABLE_TYPES, type MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";
import { detectContent, type ContentFacet } from "../lib/content-detection.js";
import { Markdown } from "../lib/markdown.js";
import { useEditingPresence } from "../lib/use-editing-presence.js";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { ActionMenu } from "./ui/action-menu.js";
import {
  ActivityIcon,
  CheckIcon,
  ClipboardIcon,
  CloseIcon,
  CodeIcon,
  CommandIcon,
  CopyIcon,
  DocumentIcon,
  DownloadIcon,
  EditIcon,
  ImageIcon,
  LinkIcon,
  NoteIcon,
  StarIcon,
  TrashIcon,
} from "./mesh-icons.js";

const VIEW_FILTERS = [
  { value: "all", label: "All" },
  { value: "recent", label: "Recent" },
  { value: "pinned", label: "Pinned" },
  { value: "continue", label: "Continue later" },
];

const TYPE_FILTERS = [
  { value: "all", label: "All types" },
  { value: "documents", label: "Documents" },
  // These are user-facing content families, not a mirror of protocol enums.
  { value: "notes", label: "Notes" },
  { value: "links", label: "Links" },
  { value: "code", label: "Code" },
  { value: "media", label: "Media" },
  { value: "files", label: "Other files" },
  { value: "checklists", label: "Checklists" },
  { value: "commands", label: "Commands" },
  { value: "tasks", label: "Agent tasks" },
];

const EDITABLE_TYPES = new Set<MeshObjectType>(["text", "document", "code", "link"]);

const RETYPE_LABELS: Record<string, string> = { text: "Note", document: "Document", code: "Code snippet", link: "Link", checklist: "Checklist" };
const RETYPE_OPTIONS = RETYPEABLE_TYPES.map((type) => ({ value: type, label: RETYPE_LABELS[type] ?? type }));
/** Types whose text content is worth rendering as markdown rather than a plain block. */
const MARKDOWN_RENDERED_TYPES = new Set<MeshObjectType>(["text", "document"]);

function textOf(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) return String((content as TextContent).text);
  return String(content ?? "");
}

function linkName(text: string): string {
  const url = detectContent(text).urls[0];
  if (!url) return "Link";
  try {
    return new URL(url.startsWith("www.") ? `https://${url}` : url).hostname.replace(/^www\./, "") || "Link";
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || "Link";
  }
}

/** Give existing text objects containing URLs the same compact presentation. */
function semanticType(object: MeshObject): MeshObjectType {
  return object.type === "text" && detectContent(textOf(object.content)).urls.length ? "link" : object.type;
}

/** Strips markdown heading/bullet syntax so a title fallen back to the first
 *  line of body text (no explicit title) doesn't show raw "# "/"- " marks. */
function firstLineAsTitle(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim())?.trim().replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").slice(0, 72);
}

function nameFor(object: MeshObject): string {
  if (object.type === "document") return (object.content as TextContent).title || firstLineAsTitle(textOf(object.content)) || "Untitled document";
  if (object.type === "link" || semanticType(object) === "link") return linkName(textOf(object.content));
  if (object.type === "text") return firstLineAsTitle(textOf(object.content)) || "Untitled note";
  if (object.type === "code") return "Code snippet";
  if (object.type === "checklist") return "Checklist";
  if (object.type === "command") return "Command";
  if (object.type === "agent_task") return "Agent task";
  if (object.type === "clipboard") return "Clipboard";
  const file = object.content as FileContent;
  return file?.name || "Untitled file";
}

function previewFor(object: MeshObject): string {
  if (object.type === "link" || semanticType(object) === "link") return textOf(object.content);
  if (["text", "document", "code", "clipboard", "command"].includes(object.type)) return textOf(object.content);
  if (object.type === "agent_task") {
    const task = object.content as AgentTaskContent;
    return `${task.action}${task.params && Object.keys(task.params).length ? ` ${JSON.stringify(task.params)}` : ""}`;
  }
  if (object.type === "checklist") {
    const items = (object.content as ChecklistContent)?.items ?? [];
    const done = items.filter((item) => item.done).length;
    return `${done} of ${items.length} tasks complete`;
  }
  const file = object.content as FileContent;
  return file?.mimeType || "File";
}

type ContentFamily = "documents" | "notes" | "links" | "code" | "media" | "files" | "checklists" | "commands" | "tasks";

function fileDescriptor(file: FileContent): { family: "documents" | "code" | "media" | "files"; label: string } {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const codeLabels: Record<string, string> = { ts: "TypeScript", tsx: "TSX", js: "JavaScript", jsx: "JSX", py: "Python", rs: "Rust", java: "Java", kt: "Kotlin", go: "Go", rb: "Ruby", php: "PHP", swift: "Swift", c: "C", cpp: "C++", h: "Header", cs: "C#", sh: "Shell script", sql: "SQL", json: "JSON", yaml: "YAML", yml: "YAML", xml: "XML", html: "HTML", css: "CSS", md: "Markdown" };
  const documentLabels: Record<string, string> = { pdf: "PDF", doc: "Word document", docx: "Word document", odt: "OpenDocument", rtf: "Rich text", txt: "Text file", pages: "Pages document", ppt: "Presentation", pptx: "Presentation", odp: "Presentation", xls: "Spreadsheet", xlsx: "Spreadsheet", ods: "Spreadsheet", csv: "CSV" };
  if (file.mimeType.startsWith("image/")) return { family: "media", label: "Image" };
  if (codeLabels[extension]) return { family: "code", label: `${codeLabels[extension]} file` };
  if (documentLabels[extension]) return { family: "documents", label: documentLabels[extension]! };
  if (file.mimeType.startsWith("text/")) return { family: "documents", label: "Text file" };
  if (file.mimeType.startsWith("audio/")) return { family: "media", label: "Audio" };
  if (file.mimeType.startsWith("video/")) return { family: "media", label: "Video" };
  return { family: "files", label: extension ? `${extension.toUpperCase()} file` : "File" };
}

function familyOf(object: MeshObject): ContentFamily {
  if (object.type === "document") return "documents";
  if (object.type === "text" || object.type === "clipboard") return "notes";
  if (object.type === "link" || semanticType(object) === "link") return "links";
  if (object.type === "code") return "code";
  if (object.type === "image" || object.type === "file") return fileDescriptor(object.content as FileContent).family;
  if (object.type === "checklist") return "checklists";
  if (object.type === "command") return "commands";
  return "tasks";
}

/** A filter can match either the stored object type or a detected text facet. */
function detectedFacets(object: MeshObject): ContentFacet[] {
  if (["text", "document", "link", "code", "clipboard", "command"].includes(object.type)) return detectContent(textOf(object.content)).facets;
  return [];
}

function matchesTypeFilter(object: MeshObject, filter: string): boolean {
  if (filter === "all") return true;
  if (familyOf(object) === filter) return true;
  return detectedFacets(object).includes(filter as ContentFacet);
}

function displayType(object: MeshObject): string {
  if (object.type === "file" || object.type === "image") return fileDescriptor(object.content as FileContent).label;
  if (semanticType(object) === "link") return "Link";
  if (object.type === "document") return "Document";
  return object.type.replace("_", " ");
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeIcon(object: MeshObject) {
  const type = semanticType(object);
  if (type === "link") return <LinkIcon />;
  if (type === "command" || type === "agent_task") return <CommandIcon />;
  if (type === "clipboard") return <ClipboardIcon />;
  if (type === "checklist") return <CheckIcon />;
  if (type === "code") return <CodeIcon />;
  if (type === "image") return <ImageIcon />;
  if (type === "text") return <NoteIcon />;
  if (type === "document") return <DocumentIcon />;
  return <DocumentIcon />;
}

/** A soft, colour-coded background per content family so rows scan by kind at a glance. */
function typeAccent(object: MeshObject): string {
  const family = familyOf(object);
  if (family === "links") return "bg-blue-500/15 text-blue-400";
  if (family === "code") return "bg-violet-500/15 text-violet-400";
  if (family === "checklists") return "bg-emerald-500/15 text-emerald-400";
  if (family === "media") return "bg-sky-500/15 text-sky-400";
  if (family === "commands") return "bg-slate-500/15 text-slate-400";
  if (family === "tasks") return "bg-fuchsia-500/15 text-fuchsia-400";
  if (family === "notes") return "bg-amber-500/15 text-amber-400";
  if (family === "documents") {
    if (object.type === "file" && (object.content as FileContent).name.split(".").pop()?.toLowerCase() === "pdf") return "bg-rose-500/15 text-rose-400";
    return "bg-indigo-500/15 text-indigo-400";
  }
  return "bg-muted text-muted-foreground";
}

function downloadFile(file: FileContent) {
  const bytes = Uint8Array.from(atob(file.dataB64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Yesterday" / "Sep 18" (with year only if it isn't the current one). */
function dayLabel(ts: number): string {
  const diffDays = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function sharedAtLabel(ts: number, deviceName: string): string {
  const day = dayLabel(ts);
  const when = day === "Today" || day === "Yesterday" ? day.toLowerCase() : `on ${day}`;
  return `Shared ${when} at ${timeOfDay(ts)} from ${deviceName}`;
}

function timeAgo(timestamp: number) {
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Groups already-sorted (desc by updatedAt) objects into ordered day buckets. */
function groupByDay(objects: MeshObject[]): Array<[string, MeshObject[]]> {
  const groups = new Map<string, MeshObject[]>();
  for (const object of objects) {
    const label = dayLabel(object.updatedAt);
    const bucket = groups.get(label);
    if (bucket) bucket.push(object);
    else groups.set(label, [object]);
  }
  return Array.from(groups.entries());
}

export function LibraryPanel(props: { db: ScreenMeshDb; me: LocalIdentity; engine: MeshEngine }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const objects = useLiveQuery(() => props.db.objects.orderBy("updatedAt").reverse().toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const localStates = useLiveQuery(() => props.db.objectStates.toArray(), [props.db]) ?? [];
  const stateByObject = useMemo(() => new Map(localStates.map((state) => [state.objectId, state])), [localStates]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return objects.filter((object) => {
      if (!matchesTypeFilter(object, typeFilter)) return false;
      const local = stateByObject.get(object.id);
      if (view === "pinned" && !local?.pinned) return false;
      if (view === "continue" && !local?.continueLater) return false;
      if (view === "recent" && !local?.lastOpenedAt) return false;
      return !needle || `${nameFor(object)} ${previewFor(object)} ${displayType(object)} ${(local?.tags ?? []).join(" ")}`.toLowerCase().includes(needle);
    });
  }, [objects, query, stateByObject, typeFilter, view]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const selected = objects.find((object) => object.id === selectedId) ?? null;
  const nameOf = (id: string) => id === props.me.deviceId ? "You" : devices.find((device) => device.id === id)?.name ?? "Unknown device";

  function togglePinned(objectId: string, local: ObjectLocalState | undefined) {
    void props.db.objectStates.put({ ...local, objectId, pinned: !local?.pinned });
  }
  function toggleContinueLater(objectId: string, local: ObjectLocalState | undefined) {
    void props.db.objectStates.put({ ...local, objectId, continueLater: !local?.continueLater });
  }
  function open(object: MeshObject, local: ObjectLocalState | undefined) {
    void props.db.objectStates.put({ ...local, objectId: object.id, lastOpenedAt: Date.now() });
    setSelectedId(object.id);
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Library">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Private mesh archive</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">Everything shared across your devices, ready to view and continue.</p>
        </div>
        <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{objects.length} {objects.length === 1 ? "object" : "objects"}</span>
      </div>

      <div className="mt-5 space-y-3 border-y border-border py-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, contents, and tags…" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring sm:max-w-xl" />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex max-w-full gap-1 overflow-x-auto pb-0.5" aria-label="Library view">
            {VIEW_FILTERS.map((item) => <button key={item.value} type="button" onClick={() => setView(item.value)} className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors ${view === item.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>{item.label}</button>)}
          </div>
          <div className="flex items-center gap-2 sm:w-44">
            <span className="shrink-0 text-[11px] text-muted-foreground">Type</span>
            <SelectMenu className="min-w-0 flex-1" ariaLabel="Filter library by type" value={typeFilter} onValueChange={setTypeFilter} options={TYPE_FILTERS.map(({ value, label }) => ({ value, label }))} />
          </div>
        </div>
      </div>

      {groups.length ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none pb-5">
          {groups.map(([label, items]) => (
            <div key={label}>
              <p className="sticky top-0 z-[1] bg-background/95 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground backdrop-blur">{label}</p>
              <div className="divide-y divide-border/60">
                {items.map((object) => {
                  const local = stateByObject.get(object.id);
                  return (
                    <div key={object.id} onClick={() => open(object, local)} className="group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/60">
                      <span className="w-11 shrink-0 text-xs tabular-nums text-muted-foreground">{timeOfDay(object.updatedAt)}</span>
                      <span className={`grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4 ${typeAccent(object)}`}>{typeIcon(object)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{nameFor(object)}</p>
                        <p className={`truncate text-xs leading-5 ${semanticType(object) === "link" ? "text-blue-400" : "text-muted-foreground"} ${object.type === "code" || object.type === "command" ? "font-mono" : ""}`}>{previewFor(object)}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{nameOf(object.createdBy)} · {timeAgo(object.updatedAt)}</p>
                      </div>
                      <button
                        type="button"
                        aria-label={local?.pinned ? "Unpin" : "Pin"}
                        aria-pressed={!!local?.pinned}
                        onClick={(event) => { event.stopPropagation(); togglePinned(object.id, local); }}
                        className={`grid size-7 shrink-0 place-items-center rounded-md transition-colors [&_svg]:size-4 ${local?.pinned ? "text-amber-400" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                      >
                        <StarIcon fill={local?.pinned ? "currentColor" : "none"} />
                      </button>
                      <ActionMenu
                        ariaLabel={`More actions for ${nameFor(object)}`}
                        items={[
                          { key: "pin", label: local?.pinned ? "Unpin" : "Pin", icon: <StarIcon fill={local?.pinned ? "currentColor" : "none"} />, onSelect: () => togglePinned(object.id, local) },
                          { key: "continue", label: local?.continueLater ? "Resume" : "Continue later", icon: <ActivityIcon />, onSelect: () => toggleContinueLater(object.id, local) },
                          { key: "delete", label: "Delete", icon: <TrashIcon />, destructive: true, onSelect: () => void props.engine.deleteObjectLocal(object.id) },
                        ]}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="flex flex-1 flex-col items-center justify-center px-4 text-center"><span className="grid size-10 place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4"><ActivityIcon /></span><p className="mt-3 text-sm font-medium">{objects.length ? "No matching objects" : "Your library is empty"}</p><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{objects.length ? "Try a different search or filter." : "Objects you send or receive will remain available here across the mesh."}</p></div>}

      {selected && <ObjectDetail object={selected} devices={devices} me={props.me} engine={props.engine} db={props.db} localState={stateByObject.get(selected.id)} onClose={() => setSelectedId(null)} nameOf={nameOf} />}
    </section>
  );
}

function ObjectDetail(props: { object: MeshObject; devices: Array<{ id: string; name: string; status: "online" | "offline" }>; me: LocalIdentity; engine: MeshEngine; db: ScreenMeshDb; localState: ObjectLocalState | undefined; nameOf: (id: string) => string; onClose: () => void }) {
  const [draft, setDraft] = useState(() => textOf(props.object.content));
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const editable = EDITABLE_TYPES.has(props.object.type);
  const file = props.object.type === "file" || props.object.type === "image" ? props.object.content as FileContent : null;
  const checklist = props.object.type === "checklist" ? props.object.content as ChecklistContent : null;
  const text = !file && !checklist && props.object.type !== "agent_task" ? textOf(props.object.content) : "";
  const presentedType = semanticType(props.object);
  const link = detectContent(text).urls[0];
  const others = props.devices.filter((device) => device.id !== props.me.deviceId);
  const canRetype = RETYPEABLE_TYPES.includes(props.object.type);
  const editingElsewhere = useEditingPresence(props.engine, props.object.id, editable && editing);

  function saveChecklist(items: ChecklistContent["items"]) { void props.engine.updateObjectContent(props.object.id, { items }); }
  async function copy() { await navigator.clipboard.writeText(text); }
  async function sendCopy() {
    if (!target) return;
    await props.engine.sendObject({ type: props.object.type, content: props.object.content }, [target]);
    setTarget("");
  }
  function updateLocal(next: Partial<ObjectLocalState>) { void props.db.objectStates.put({ ...props.localState, objectId: props.object.id, ...next }); }
  function addTag() {
    const tag = tagDraft.trim().replace(/\s+/g, " ");
    if (!tag || props.localState?.tags?.includes(tag)) return;
    updateLocal({ tags: [...(props.localState?.tags ?? []), tag] });
    setTagDraft("");
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Object details">
      <div className="absolute inset-0 bg-black/48 backdrop-blur-[6px]" onClick={props.onClose} />
      <article className="absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-background sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(75vw,880px)] sm:rounded-none sm:border-l sm:border-t-0">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex min-w-0 gap-3">
            <span className={`grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4 ${typeAccent(props.object)}`}>{typeIcon(props.object)}</span>
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">{sharedAtLabel(props.object.updatedAt, props.nameOf(props.object.createdBy))}</p>
              <h2 className="truncate text-lg font-semibold">{nameFor(props.object)}</h2>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={props.localState?.pinned ? "Unpin" : "Pin"}
              aria-pressed={!!props.localState?.pinned}
              onClick={() => updateLocal({ pinned: !props.localState?.pinned })}
              className={`grid size-8 place-items-center rounded-md transition-colors [&_svg]:size-4 ${props.localState?.pinned ? "text-amber-400" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            >
              <StarIcon fill={props.localState?.pinned ? "currentColor" : "none"} />
            </button>
            <Button size="icon" variant="ghost" aria-label="Close details" onClick={props.onClose}><CloseIcon /></Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {(props.localState?.tags ?? []).map((tag) => <button key={tag} type="button" onClick={() => updateLocal({ tags: (props.localState?.tags ?? []).filter((item) => item !== tag) })} className="rounded-full border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground">{tag} ×</button>)}
                <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); addTag(); }}><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="Add tag" className="h-6 w-20 rounded border border-input bg-background px-2 text-[10px] outline-none focus:ring-1 focus:ring-ring" /></form>
              </div>
              {canRetype && (
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-[10px] text-muted-foreground">Wrong type?</span>
                  <SelectMenu className="min-w-0" ariaLabel="Change object type" value={props.object.type} onValueChange={(value) => void props.engine.retypeObject(props.object.id, value as MeshObjectType)} options={RETYPE_OPTIONS} />
                </div>
              )}
            </div>
            {file?.mimeType.startsWith("image/") && <img src={`data:${file.mimeType};base64,${file.dataB64}`} alt={file.name} className="max-h-[52dvh] w-full rounded-xl border border-border object-contain" />}
            {file && <div className="rounded-lg border border-border bg-card px-4 py-3"><p className="text-sm font-medium">{file.name}</p><p className="mt-1 text-xs text-muted-foreground">{file.mimeType} · {formatSize(file.size)}</p></div>}
            {checklist && <div className="space-y-2 rounded-xl border border-border bg-card p-4">{checklist.items.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={item.done} onChange={() => saveChecklist(checklist.items.map((entry) => entry.id === item.id ? { ...entry, done: !entry.done } : entry))} className="size-4 rounded border-input accent-foreground" /><span className={item.done ? "text-muted-foreground line-through" : ""}>{item.text}</span></label>)}</div>}
            {props.object.type === "agent_task" && <pre className="overflow-x-auto rounded-xl bg-foreground p-4 text-xs leading-6 text-primary-foreground">{JSON.stringify(props.object.content as AgentTaskContent, null, 2)}</pre>}
            {editable && editingElsewhere.length > 0 && (
              <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-[11px] text-amber-500">
                {editingElsewhere.map((id) => props.nameOf(id)).join(", ")} {editingElsewhere.length === 1 ? "is" : "are"} also editing this right now — edits merge, but check before saving to avoid stepping on each other.
              </p>
            )}
            {!file && !checklist && props.object.type !== "agent_task" && (
              editing
                ? <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} className={`min-h-52 w-full resize-y rounded-xl border border-input bg-card p-4 text-sm leading-6 outline-none focus:ring-1 focus:ring-ring ${props.object.type === "code" ? "font-mono" : ""}`} />
                : MARKDOWN_RENDERED_TYPES.has(props.object.type)
                  ? <div className="min-h-28 rounded-xl border border-border bg-card p-4"><Markdown text={text} /></div>
                  : <div className={`min-h-28 whitespace-pre-wrap break-words rounded-xl border border-border bg-card p-4 text-sm leading-6 ${props.object.type === "code" || props.object.type === "command" ? "font-mono" : ""}`}>{text}</div>
            )}
          </div>
        </div>
        <footer className="shrink-0 space-y-3 border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {presentedType === "link" && link && <Button size="sm" variant="outline" onClick={() => window.open(link.startsWith("www.") ? `https://${link}` : link, "_blank", "noopener")}><LinkIcon /> Open link</Button>}
            {text && <Button size="sm" variant="outline" onClick={() => void copy()}><CopyIcon /> Copy</Button>}
            {file && <Button size="sm" variant="outline" onClick={() => downloadFile(file)}><DownloadIcon /> Download</Button>}
            <Button size="sm" variant="outline" onClick={() => updateLocal({ continueLater: !props.localState?.continueLater })}>{props.localState?.continueLater ? "Resume" : "Continue later"}</Button>
            {editable && (editing ? <Button size="sm" onClick={() => { void props.engine.editText(props.object.id, draft); setEditing(false); }}><CheckIcon /> Save changes</Button> : <Button size="sm" variant="outline" onClick={() => setEditing(true)}><EditIcon /> Edit</Button>)}
            <Button size="sm" variant="outline" className="text-muted-foreground hover:text-destructive" onClick={() => { void props.engine.deleteObjectLocal(props.object.id); props.onClose(); }}><TrashIcon /> Delete</Button>
          </div>
          {others.length > 0 && <div className="flex gap-2"><SelectMenu className="min-w-0 flex-1" ariaLabel="Send copy to device" placeholder="Send a copy to…" value={target} onValueChange={setTarget} options={others.map((device) => ({ value: device.id, label: device.name, description: device.status === "online" ? "Online" : "Offline — queues safely" }))} /><Button size="sm" disabled={!target} onClick={() => void sendCopy()}>Send</Button></div>}
        </footer>
      </article>
    </div>
  );
}
