import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type {
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

const EDITABLE_TYPES = new Set(["text", "code", "link"]);

function isFileObject(object: MeshObject): boolean {
  return object.type === "image" || object.type === "file";
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
    <div className="stack">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => push(e.target.value)}
        style={{ minHeight: "6rem" }}
      />
      <div className="actions">
        <button
          className="ghost"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            void props.engine.editText(props.object.id, draft).then(props.onClose);
          }}
        >
          Done
        </button>
        <span className="muted">Edits merge across devices, even concurrent ones.</span>
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
    <div className="stack" style={{ margin: "0.4rem 0" }}>
      {items.map((item) => (
        <label className="check" key={item.id}>
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
          />
          <span style={item.done ? { textDecoration: "line-through", opacity: 0.6 } : {}}>
            {item.text}
          </span>
        </label>
      ))}
      <form
        style={{ display: "flex", gap: "0.4rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          const text = newItem.trim();
          if (!text) return;
          save({
            items: [...items, { id: crypto.randomUUID(), text, done: false }],
          });
          setNewItem("");
        }}
      >
        <input
          type="text"
          placeholder="Add item…"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
        />
        <button className="ghost" type="submit" disabled={!newItem.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

export function InboxPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  engine: MeshEngine;
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

  async function markOpenedIfReceived(object: MeshObject) {
    if (object.createdBy !== props.me.deviceId) {
      await props.engine.markOpened(object.id);
    }
  }

  return (
    <section className="card">
      <h2>Objects</h2>
      {continuedFrom && (
        <p className="muted">Continued here from {continuedFrom}.</p>
      )}
      {objects.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul className="plain">
        {objects.map((object) => {
          const mine = object.createdBy === props.me.deviceId;
          const delivery = mine ? undefined : deliveryByObjectId.get(object.id);
          const pending = delivery?.status === "pending";
          const file = isFileObject(object) ? (object.content as FileContent) : null;
          const isChecklist = object.type === "checklist";
          const text = file || isChecklist ? null : textOf(object.content);
          const editable = EDITABLE_TYPES.has(object.type);
          const editing = editingId === object.id;
          return (
            <li
              className="row"
              key={object.id}
              id={`obj-${object.id}`}
              style={{ alignItems: "flex-start" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="muted">
                  <span className="badge">{object.type}</span>{" "}
                  {mine ? "by me" : `from ${nameOf(object.createdBy)}`} ·{" "}
                  {new Date(object.updatedAt).toLocaleTimeString()}
                  {object.expiresAt !== undefined && (
                    <> · {formatExpiry(object.expiresAt, Date.now())}</>
                  )}
                  {pending && <> · awaiting your confirmation</>}
                </div>
                {object.type === "image" && file && (
                  <img
                    src={`data:${file.mimeType};base64,${file.dataB64}`}
                    alt={file.name}
                    style={{ maxWidth: "100%", borderRadius: 8, margin: "0.4rem 0" }}
                    onLoad={() => void markOpenedIfReceived(object)}
                  />
                )}
                {file && (
                  <p className="obj-text">
                    {file.name} <span className="muted">({formatSize(file.size)})</span>
                  </p>
                )}
                {isChecklist && !pending && <Checklist object={object} engine={props.engine} />}
                {text !== null && !editing && (
                  <p className={`obj-text ${object.type === "code" ? "mono" : ""}`}>
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
                  <div className="actions">
                    <button onClick={() => void props.engine.acceptObject(object.id)}>
                      Accept
                    </button>
                    <button
                      className="ghost"
                      onClick={() => void props.engine.rejectObject(object.id)}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <div className="actions">
                    {editable && !editing && (
                      <button
                        className="ghost"
                        onClick={() => {
                          setEditingId(object.id);
                          void markOpenedIfReceived(object);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {file && (
                      <button
                        className="ghost"
                        onClick={() => {
                          downloadFile(file);
                          void markOpenedIfReceived(object);
                        }}
                      >
                        Download
                      </button>
                    )}
                    {text !== null && (
                      <button
                        className="ghost"
                        onClick={async () => {
                          await navigator.clipboard.writeText(text);
                          await markOpenedIfReceived(object);
                        }}
                      >
                        {object.type === "clipboard" ? "📋 Paste to my clipboard" : "Copy"}
                      </button>
                    )}
                    {object.type === "link" && text !== null && (
                      <button
                        className="ghost"
                        onClick={() => {
                          window.open(text, "_blank", "noopener");
                          void markOpenedIfReceived(object);
                        }}
                      >
                        Open
                      </button>
                    )}
                    {others.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) {
                            void props.engine.continueOnDevice(object.id, e.target.value);
                          }
                          e.target.value = "";
                        }}
                      >
                        <option value="" disabled>
                          Continue on…
                        </option>
                        {others.map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name}
                            {device.status === "offline" ? " (offline)" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      className="ghost"
                      onClick={() => void props.engine.deleteObjectLocal(object.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
