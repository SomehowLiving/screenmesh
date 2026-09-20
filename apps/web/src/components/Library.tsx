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
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import {
  ActivityIcon,
  CheckIcon,
  ClipboardIcon,
  CloseIcon,
  CommandIcon,
  CopyIcon,
  DownloadIcon,
  EditIcon,
  LinkIcon,
  TrashIcon,
} from "./mesh-icons.js";

const FILTERS: Array<{ value: string; label: string; types?: MeshObjectType[] }> = [
  { value: "all", label: "All" },
  // These are user-facing content families, not a mirror of protocol enums.
  { value: "notes", label: "Notes", types: ["text", "clipboard"] },
  { value: "links", label: "Links", types: ["link"] },
  { value: "code", label: "Code", types: ["code"] },
  { value: "media", label: "Media", types: ["image"] },
  { value: "files", label: "Files", types: ["file"] },
  { value: "checklists", label: "Checklists", types: ["checklist"] },
  { value: "commands", label: "Commands", types: ["command"] },
  { value: "tasks", label: "Agent tasks", types: ["agent_task"] },
];

const EDITABLE_TYPES = new Set<MeshObjectType>(["text", "code", "link"]);

function textOf(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) return String((content as TextContent).text);
  return String(content ?? "");
}

function nameFor(object: MeshObject): string {
  if (object.type === "link") return textOf(object.content).replace(/^https?:\/\//, "").split("/")[0] || "Link";
  if (object.type === "text") return textOf(object.content).split("\n").find(Boolean)?.slice(0, 72) || "Untitled note";
  if (object.type === "code") return "Code snippet";
  if (object.type === "checklist") return "Checklist";
  if (object.type === "command") return "Command";
  if (object.type === "agent_task") return "Agent task";
  if (object.type === "clipboard") return "Clipboard";
  const file = object.content as FileContent;
  return file?.name || "Untitled file";
}

function previewFor(object: MeshObject): string {
  if (["text", "link", "code", "clipboard", "command"].includes(object.type)) return textOf(object.content);
  if (object.type === "agent_task") {
    const task = object.content as AgentTaskContent;
    return `${task.action}${task.params && Object.keys(task.params).length ? ` ${JSON.stringify(task.params)}` : ""}`;
  }
  if (object.type === "checklist") {
    const items = (object.content as ChecklistContent)?.items ?? [];
    return items.map((item) => item.text).join(" · ");
  }
  const file = object.content as FileContent;
  return file?.mimeType || "File";
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeIcon(type: MeshObjectType) {
  if (type === "link") return <LinkIcon />;
  if (type === "command" || type === "agent_task") return <CommandIcon />;
  if (type === "clipboard") return <ClipboardIcon />;
  if (type === "checklist") return <CheckIcon />;
  return <ActivityIcon />;
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

function timeAgo(timestamp: number) {
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function LibraryPanel(props: { db: ScreenMeshDb; me: LocalIdentity; engine: MeshEngine }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const objects = useLiveQuery(() => props.db.objects.orderBy("updatedAt").reverse().toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return objects.filter((object) => {
      const contentFamily = FILTERS.find((item) => item.value === filter);
      if (contentFamily?.types && !contentFamily.types.includes(object.type)) return false;
      return !needle || `${nameFor(object)} ${previewFor(object)}`.toLowerCase().includes(needle);
    });
  }, [filter, objects, query]);
  const selected = objects.find((object) => object.id === selectedId) ?? null;
  const nameOf = (id: string) => id === props.me.deviceId ? "You" : devices.find((device) => device.id === id)?.name ?? "Unknown device";

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

      <div className="mt-5 flex flex-col gap-3 border-y border-border py-3 sm:flex-row sm:items-center">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your mesh…" className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />
        <div className="flex max-w-full gap-1 overflow-x-auto pb-0.5 sm:flex-none">
          {FILTERS.map((item) => <button key={item.value} type="button" onClick={() => setFilter(item.value)} className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs transition-colors ${filter === item.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>{item.label}</button>)}
        </div>
      </div>

      {visible.length ? (
        <div className="mt-4 grid gap-3 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((object) => {
            const image = object.type === "image" ? object.content as FileContent : null;
            const checklist = object.type === "checklist" ? object.content as ChecklistContent : null;
            const done = checklist?.items.filter((item) => item.done).length ?? 0;
            return <button key={object.id} type="button" onClick={() => setSelectedId(object.id)} className="group min-h-40 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus:outline-none focus:ring-1 focus:ring-ring">
              {image ? <img src={`data:${image.mimeType};base64,${image.dataB64}`} alt="" className="mb-3 h-24 w-full rounded-lg border border-border object-cover" /> : <div className="mb-3 flex items-center justify-between"><span className="grid size-8 place-items-center rounded-md border border-border bg-background text-muted-foreground [&_svg]:size-4">{typeIcon(object.type)}</span><span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{object.type.replace("_", " ")}</span></div>}
              <p className="truncate text-sm font-medium">{nameFor(object)}</p>
              <p className={`mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground ${object.type === "code" || object.type === "command" ? "font-mono" : ""}`}>{previewFor(object)}</p>
              <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground"><span>{nameOf(object.createdBy)} · {timeAgo(object.updatedAt)}</span>{checklist && <span>{done}/{checklist.items.length} done</span>}{(object.type === "file" || object.type === "image") && <span>{formatSize((object.content as FileContent).size)}</span>}</div>
            </button>;
          })}
        </div>
      ) : <div className="flex flex-1 flex-col items-center justify-center px-4 text-center"><span className="grid size-10 place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4"><ActivityIcon /></span><p className="mt-3 text-sm font-medium">{objects.length ? "No matching objects" : "Your library is empty"}</p><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{objects.length ? "Try a different search or filter." : "Objects you send or receive will remain available here across the mesh."}</p></div>}

      {selected && <ObjectDetail object={selected} devices={devices} me={props.me} engine={props.engine} onClose={() => setSelectedId(null)} nameOf={nameOf} />}
    </section>
  );
}

function ObjectDetail(props: { object: MeshObject; devices: Array<{ id: string; name: string; status: "online" | "offline" }>; me: LocalIdentity; engine: MeshEngine; nameOf: (id: string) => string; onClose: () => void }) {
  const [draft, setDraft] = useState(() => textOf(props.object.content));
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState("");
  const editable = EDITABLE_TYPES.has(props.object.type);
  const file = props.object.type === "file" || props.object.type === "image" ? props.object.content as FileContent : null;
  const checklist = props.object.type === "checklist" ? props.object.content as ChecklistContent : null;
  const text = !file && !checklist && props.object.type !== "agent_task" ? textOf(props.object.content) : "";
  const others = props.devices.filter((device) => device.id !== props.me.deviceId);

  function saveChecklist(items: ChecklistContent["items"]) { void props.engine.updateObjectContent(props.object.id, { items }); }
  async function copy() { await navigator.clipboard.writeText(text); }
  async function sendCopy() {
    if (!target) return;
    await props.engine.sendObject({ type: props.object.type, content: props.object.content }, [target]);
    setTarget("");
  }

  return <div className="fixed inset-0 z-50 flex items-end bg-foreground/20 p-0 backdrop-blur-[1px] sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="Object details" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <article className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-border bg-background shadow-2xl sm:max-w-2xl sm:rounded-2xl">
      <header className="sticky top-0 z-10 flex items-start justify-between border-b border-border bg-background/95 px-5 py-4 backdrop-blur"><div className="flex min-w-0 gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground [&_svg]:size-4">{typeIcon(props.object.type)}</span><div><p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{props.object.type.replace("_", " ")}</p><h2 className="truncate text-base font-semibold">{nameFor(props.object)}</h2><p className="mt-0.5 text-xs text-muted-foreground">Shared by {props.nameOf(props.object.createdBy)} · updated {timeAgo(props.object.updatedAt)}</p></div></div><Button size="icon" variant="ghost" aria-label="Close details" onClick={props.onClose}><CloseIcon /></Button></header>
      <div className="space-y-5 px-5 py-5">
        {file?.mimeType.startsWith("image/") && <img src={`data:${file.mimeType};base64,${file.dataB64}`} alt={file.name} className="max-h-[52dvh] w-full rounded-xl border border-border object-contain" />}
        {file && <div className="rounded-lg border border-border bg-card px-4 py-3"><p className="text-sm font-medium">{file.name}</p><p className="mt-1 text-xs text-muted-foreground">{file.mimeType} · {formatSize(file.size)}</p></div>}
        {checklist && <div className="space-y-2 rounded-xl border border-border bg-card p-4">{checklist.items.map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" checked={item.done} onChange={() => saveChecklist(checklist.items.map((entry) => entry.id === item.id ? { ...entry, done: !entry.done } : entry))} className="size-4 rounded border-input accent-foreground" /><span className={item.done ? "text-muted-foreground line-through" : ""}>{item.text}</span></label>)}</div>}
        {props.object.type === "agent_task" && <pre className="overflow-x-auto rounded-xl bg-foreground p-4 text-xs leading-6 text-primary-foreground">{JSON.stringify(props.object.content as AgentTaskContent, null, 2)}</pre>}
        {!file && !checklist && props.object.type !== "agent_task" && (editing ? <textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} className={`min-h-52 w-full resize-y rounded-xl border border-input bg-card p-4 text-sm leading-6 outline-none focus:ring-1 focus:ring-ring ${props.object.type === "code" ? "font-mono" : ""}`} /> : <div className={`min-h-28 whitespace-pre-wrap break-words rounded-xl border border-border bg-card p-4 text-sm leading-6 ${props.object.type === "code" || props.object.type === "command" ? "font-mono" : ""}`}>{text}</div>)}
      </div>
      <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-5 py-3 backdrop-blur">
        {editable && (editing ? <Button size="sm" onClick={() => { void props.engine.editText(props.object.id, draft); setEditing(false); }}><CheckIcon /> Save changes</Button> : <Button size="sm" variant="outline" onClick={() => setEditing(true)}><EditIcon /> Edit</Button>)}
        {text && <Button size="sm" variant="outline" onClick={() => void copy()}><CopyIcon /> Copy</Button>}
        {props.object.type === "link" && text && <Button size="sm" variant="outline" onClick={() => window.open(text, "_blank", "noopener")}><LinkIcon /> Open</Button>}
        {file && <Button size="sm" variant="outline" onClick={() => downloadFile(file)}><DownloadIcon /> Download</Button>}
        {others.length > 0 && <div className="ml-auto flex min-w-[190px] flex-1 gap-2 sm:flex-none"><SelectMenu className="min-w-0 flex-1" ariaLabel="Send copy to device" placeholder="Send a copy to…" value={target} onValueChange={setTarget} options={others.map((device) => ({ value: device.id, label: device.name, description: device.status === "online" ? "Online" : "Offline — queues safely" }))} /><Button size="sm" disabled={!target} onClick={() => void sendCopy()}>Send</Button></div>}
        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => { void props.engine.deleteObjectLocal(props.object.id); props.onClose(); }}><TrashIcon /> Delete</Button>
      </footer>
    </article>
  </div>;
}
