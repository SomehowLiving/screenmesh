import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { MeshObjectType } from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";

function detectType(text: string): MeshObjectType {
  return /^https?:\/\/\S+$/i.test(text.trim()) ? "link" : "text";
}

export function SendPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  engine: MeshEngine;
}) {
  const [text, setText] = useState("");
  const [type, setType] = useState<MeshObjectType | "auto">("auto");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const others =
    useLiveQuery(
      () => props.db.devices.where("id").notEqual(props.me.deviceId).toArray(),
      [props.db, props.me.deviceId],
    ) ?? [];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const recipients = others.filter((d) => selected.has(d.id));

  async function send() {
    const content = text.trim();
    if (!content || recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const objectType = type === "auto" ? detectType(content) : type;
      await props.engine.sendObject(
        { type: objectType, content: { text: content } },
        recipients.map((d) => d.id),
      );
      setText("");
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
      {others.length === 0 ? (
        <p className="muted">Pair another device to send things to it.</p>
      ) : (
        <div className="stack">
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
      <button disabled={busy || !text.trim() || recipients.length === 0} onClick={() => void send()}>
        Send
      </button>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
