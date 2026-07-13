import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { toBase64, type FileContent, type MeshObjectType } from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";

/** Envelopes travel as JSON over the relay — keep attachments small. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function detectType(text: string): MeshObjectType {
  return /^https?:\/\/\S+$/i.test(text.trim()) ? "link" : "text";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SendPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  engine: MeshEngine;
}) {
  const [text, setText] = useState("");
  const [type, setType] = useState<MeshObjectType | "auto">("auto");
  const [file, setFile] = useState<FileContent | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const others =
    useLiveQuery(
      () => props.db.devices.where("id").notEqual(props.me.deviceId).toArray(),
      [props.db, props.me.deviceId],
    ) ?? [];

  const allSelected = others.length > 0 && others.every((d) => selected.has(d.id));
  const recipients = others.filter((d) => selected.has(d.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(others.map((d) => d.id)));
  }

  async function attach(picked: File) {
    if (picked.size > MAX_FILE_BYTES) {
      setNote(`File is too large (${formatSize(picked.size)}) — the limit is 5 MB for now.`);
      return;
    }
    const bytes = new Uint8Array(await picked.arrayBuffer());
    setFile({
      name: picked.name,
      mimeType: picked.type || "application/octet-stream",
      size: picked.size,
      dataB64: toBase64(bytes),
    });
    setNote(null);
  }

  async function send() {
    const content = text.trim();
    if ((!content && !file) || recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const recipientIds = recipients.map((d) => d.id);
      if (file) {
        await props.engine.sendObject(
          {
            type: file.mimeType.startsWith("image/") ? "image" : "file",
            content: file,
          },
          recipientIds,
        );
        setFile(null);
      }
      if (content) {
        const objectType = type === "auto" ? detectType(content) : type;
        await props.engine.sendObject(
          { type: objectType, content: { text: content } },
          recipientIds,
        );
        setText("");
      }
      setNote(
        `Sent to ${recipients.map((d) => d.name).join(", ")} — offline devices get it when they reconnect.`,
      );
    } catch (err) {
      setNote(`Send failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>Send to device</h2>
      <textarea
        placeholder="Paste a link, command, snippet, or note…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select value={type} onChange={(e) => setType(e.target.value as MeshObjectType | "auto")}>
        <option value="auto">Auto-detect type</option>
        <option value="text">Text</option>
        <option value="link">Link</option>
        <option value="code">Code / command</option>
      </select>
      {file ? (
        <div className="row" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className="badge">{file.mimeType.startsWith("image/") ? "image" : "file"}</span>
          <span style={{ flex: 1 }}>
            {file.name} <span className="muted">({formatSize(file.size)})</span>
          </span>
          <button className="ghost" onClick={() => setFile(null)}>
            Remove
          </button>
        </div>
      ) : (
        <label className="check">
          <input
            type="file"
            style={{ display: "none" }}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void attach(picked);
              e.target.value = "";
            }}
          />
          <span className="badge">＋ attach image or file (up to 5 MB)</span>
        </label>
      )}
      {others.length === 0 ? (
        <p className="muted">Pair another device to send things to it.</p>
      ) : (
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <strong>All devices</strong>
          </label>
          {others.map((device) => (
            <label className="check" key={device.id}>
              <input
                type="checkbox"
                checked={selected.has(device.id)}
                onChange={() => toggle(device.id)}
              />
              <span className={`dot ${device.status}`} />
              {device.name}
              {device.status === "offline" && (
                <span className="muted">(queued until it returns)</span>
              )}
            </label>
          ))}
        </div>
      )}
      <button
        disabled={busy || (!text.trim() && !file) || recipients.length === 0}
        onClick={() => void send()}
      >
        Send
      </button>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
