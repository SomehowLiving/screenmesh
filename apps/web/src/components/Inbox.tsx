import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type {
  AgentTaskContent,
  ChecklistContent,
  Delivery,
  Device,
  FileContent,
  MeshObject,
  TextContent,
} from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { ActivityIcon, CommandIcon, LinkIcon } from "./mesh-icons.js";

const EDITABLE_TYPES = new Set(["text", "code", "link"]);

function isFileObject(object: MeshObject): boolean {
  return object.type === "image" || object.type === "file";
}

function formatAgentTask(content: AgentTaskContent): string {
  const params = content.params && Object.keys(content.params).length > 0
    ? JSON.stringify(content.params)
    : "";
  return `${content.action}(${params})`;
}

function textOf(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) {
    return String((content as TextContent).text);
  }
  return String(content ?? "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExpiry(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expiring…";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "expires in under a minute";
  if (mins < 60) return `expires in ${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `expires in ${hours}h` : `expires in ${Math.round(hours / 24)}d`;
}

function downloadFile(file: FileContent) {
  const bytes = Uint8Array.from(atob(file.dataB64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function typeIcon(type: string) {
  if (type === "command" || type === "agent_task") return <CommandIcon />;
  if (type === "link") return <LinkIcon />;
  return <ActivityIcon />;
}

/** Collaborative text editor: local keystrokes → debounced Yjs merge. */
function TextEditor(props: {
  object: MeshObject;
  engine: MeshEngine;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(textOf(props.object.content));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function push(next: string) {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void props.engine.editText(props.object.id, next);
    }, 400);
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => push(e.target.value)}
        className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            void props.engine.editText(props.object.id, draft).then(props.onClose);
          }}
        >
          Done
        </Button>
        <span className="text-[11px] text-muted-foreground">Edits merge across devices, even concurrent ones.</span>
      </div>
    </div>
  );
}

function Checklist(props: { object: MeshObject; engine: MeshEngine }) {
  const content = props.object.content as ChecklistContent;
  const items = content?.items ?? [];
  const [newItem, setNewItem] = useState("");

  function save(next: ChecklistContent) {
    void props.engine.updateObjectContent(props.object.id, next);
  }

  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={item.done}
            onChange={() =>
              save({
                items: items.map((i) =>
                  i.id === item.id ? { ...i, done: !i.done } : i,
                ),
              })
            }
            className="size-3.5 rounded-sm border-input accent-foreground"
          />
          <span className={item.done ? "text-muted-foreground line-through" : ""}>{item.text}</span>
        </label>
      ))}
      <form
        className="flex gap-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          const text = newItem.trim();
          if (!text) return;
          save({ items: [...items, { id: crypto.randomUUID(), text, done: false }] });
          setNewItem("");
        }}
      >
        <input
          type="text"
          placeholder="Add item…"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <Button size="sm" variant="outline" type="submit" disabled={!newItem.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}

export function InboxPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  engine: MeshEngine;
  filter: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [continuedFrom, setContinuedFrom] = useState<string | null>(null);

  const objects =
    useLiveQuery(
      () => props.db.objects.orderBy("updatedAt").reverse().toArray(),
      [props.db],
    ) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const focus = useLiveQuery(() => props.db.settings.get("focusObject"), [props.db]);
  // My incoming delivery record per object — drives the pending-confirmation gate.
  const incoming =
    useLiveQuery(
      () =>
        props.db.deliveries
          .where("destinationDeviceId")
          .equals(props.me.deviceId)
          .toArray(),
      [props.db, props.me.deviceId],
    ) ?? [];
  const deliveryByObjectId = new Map<string, Delivery>(incoming.map((d) => [d.objectId, d]));

  const nameOf = (id: string) =>
    id === props.me.deviceId
      ? "me"
      : (devices.find((d) => d.id === id)?.name ?? "unknown device");
  const others: Device[] = devices.filter((d) => d.id !== props.me.deviceId);

  // Continue-on-device: another device asked us to open this object.
  useEffect(() => {
    const value = focus?.value as { objectId: string; from: string } | undefined;
    if (!value) return;
    setEditingId(value.objectId);
    setContinuedFrom(nameOf(value.from));
    void props.db.settings.delete("focusObject");
    document
      .getElementById(`obj-${value.objectId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const visible = objects.filter((object) => {
    if (props.filter === "Shared with me") return object.createdBy !== props.me.deviceId;
    if (props.filter === "Needs attention") return deliveryByObjectId.get(object.id)?.status === "pending";
    // "Active" deliberately means the current working set: the objects held
    // on this device, ordered by their most recent change. Type browsing lives
    // in Library, where it does not compete with day-to-day work.
    return true;
  });

  async function markOpenedIfReceived(object: MeshObject) {
    if (object.createdBy !== props.me.deviceId) {
      await props.engine.markOpened(object.id);
    }
  }

  if (objects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <span className="grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4">
          <ActivityIcon />
        </span>
        <p className="text-sm font-medium">Nothing here yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Objects you send or receive across the mesh will show up here.
        </p>
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <span className="grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4">
          <ActivityIcon />
        </span>
        <p className="text-sm font-medium">No {props.filter.toLowerCase()} yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">Switch the filter above, or send one from the composer.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {continuedFrom && (
        <p className="py-3 text-xs text-muted-foreground">Continued here from {continuedFrom}.</p>
      )}
      {visible.map((object) => {
        const mine = object.createdBy === props.me.deviceId;
        const delivery = mine ? undefined : deliveryByObjectId.get(object.id);
        const pending = delivery?.status === "pending";
        const file = isFileObject(object) ? (object.content as FileContent) : null;
        const isChecklist = object.type === "checklist";
        const isAgentTask = object.type === "agent_task";
        const text = file || isChecklist || isAgentTask ? null : textOf(object.content);
        const editable = EDITABLE_TYPES.has(object.type);
        const editing = editingId === object.id;

        return (
          <article key={object.id} id={`obj-${object.id}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-4">
            <div className="grid size-7 place-items-center rounded-md border border-border bg-card [&_svg]:size-3.5">
              {typeIcon(object.type)}
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-medium capitalize">{object.type}</span>
                <span className="text-[10px] text-muted-foreground">
                  {mine ? "by me" : `from ${nameOf(object.createdBy)}`} · {new Date(object.updatedAt).toLocaleTimeString()}
                  {object.expiresAt !== undefined && <> · {formatExpiry(object.expiresAt, Date.now())}</>}
                </span>
                {pending && (
                  <span className="ml-auto flex items-center gap-1.5 text-[10px] text-warning">
                    <span className="size-1 rounded-full bg-warning" /> Awaiting confirmation
                  </span>
                )}
              </div>

              {object.type === "image" && file && (
                <img
                  src={`data:${file.mimeType};base64,${file.dataB64}`}
                  alt={file.name}
                  className="mb-2 max-w-full rounded-md"
                  onLoad={() => void markOpenedIfReceived(object)}
                />
              )}
              {file && (
                <p className="text-sm">
                  {file.name} <span className="text-muted-foreground">({formatSize(file.size)})</span>
                </p>
              )}
              {isChecklist && !pending && <Checklist object={object} engine={props.engine} />}
              {isAgentTask && (
                <div className="rounded-md bg-foreground px-3 py-2.5 font-mono text-xs text-primary-foreground">
                  {formatAgentTask(object.content as AgentTaskContent)}
                </div>
              )}
              {text !== null && !editing && (
                <p className={`text-sm ${object.type === "code" ? "font-mono" : ""} whitespace-pre-wrap break-words`}>
                  {text}
                </p>
              )}
              {editing && editable && !pending && (
                <TextEditor
                  object={object}
                  engine={props.engine}
                  onClose={() => {
                    setEditingId(null);
                    setContinuedFrom(null);
                  }}
                />
              )}

              {pending ? (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => void props.engine.acceptObject(object.id)}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void props.engine.rejectObject(object.id)}>
                    Reject
                  </Button>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {editable && !editing && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingId(object.id);
                        void markOpenedIfReceived(object);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                  {file && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        downloadFile(file);
                        void markOpenedIfReceived(object);
                      }}
                    >
                      Download
                    </Button>
                  )}
                  {text !== null && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await navigator.clipboard.writeText(text);
                        await markOpenedIfReceived(object);
                      }}
                    >
                      {object.type === "clipboard" ? "Extract to clipboard" : "Copy"}
                    </Button>
                  )}
                  {object.type === "link" && text !== null && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        window.open(text, "_blank", "noopener");
                        void markOpenedIfReceived(object);
                      }}
                    >
                      Open
                    </Button>
                  )}
                  {others.length > 0 && (
                    <SelectMenu
                      className="w-36"
                      ariaLabel="Continue on device"
                      placeholder="Continue on"
                      value=""
                      onValueChange={(value) => void props.engine.continueOnDevice(object.id, value)}
                      options={others.map((device) => ({
                        value: device.id,
                        label: device.name,
                        description: device.status === "online" ? "Online" : "Offline — queues until available",
                      }))}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-muted-foreground"
                    onClick={() => void props.engine.deleteObjectLocal(object.id)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
