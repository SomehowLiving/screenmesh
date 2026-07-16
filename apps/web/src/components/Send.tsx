import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  toBase64,
  type DeviceCapability,
  type FileContent,
  type MeshObjectType,
  type SendOptions,
} from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";

const CAPABILITY_CHOICES: DeviceCapability[] = [
  "terminal",
  "filesystem",
  "camera",
  "microphone",
  "gps",
  "browser",
  "local-models",
];

/**
 * Files above ~150 KB base64 travel as chunked envelopes (secure file
 * drop, see MeshEngine.sendFileChunks) rather than one giant envelope, so
 * the practical ceiling is generous — bounded here mainly to keep
 * IndexedDB and browser memory use reasonable on the sending device.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const EXPIRY_CHOICES: Array<{ label: string; ms?: number }> = [
  { label: "Never expires" },
  { label: "Expires in 10 minutes", ms: 10 * 60 * 1000 },
  { label: "Expires in 1 hour", ms: 60 * 60 * 1000 },
  { label: "Expires in 24 hours", ms: 24 * 60 * 60 * 1000 },
];

/** Temporary clipboard tunnel (FUTURE.md): share what's on the clipboard
 *  for a short, fixed window and have it erase itself automatically —
 *  built entirely on the existing expiresAt + deleteAfterOpening options. */
const CLIPBOARD_DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "1 minute", ms: 60 * 1000 },
  { label: "5 minutes", ms: 5 * 60 * 1000 },
  { label: "15 minutes", ms: 15 * 60 * 1000 },
];

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
  const [expiryIndex, setExpiryIndex] = useState(0);
  const [deleteAfterOpening, setDeleteAfterOpening] = useState(false);
  const [requireConfirmation, setRequireConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [clipboardDuration, setClipboardDuration] = useState(1); // "5 minutes"
  const [capability, setCapability] = useState<DeviceCapability>(CAPABILITY_CHOICES[0]!);

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

  /** Capability routing: resolve "whichever device has X" to concrete
   *  device(s) and add them to the normal recipient selection — online
   *  matches first, so this prefers an immediate direct send. */
  async function routeToCapability() {
    const matches = await props.engine.resolveCapability(capability);
    const best = matches[0]; // resolveCapability sorts online devices first
    if (!best) {
      setNote(`No paired device currently advertises "${capability}".`);
      return;
    }
    setSelected((prev) => new Set([...prev, best.id]));
    setNote(
      `Routed to ${best.name} (advertising "${capability}")${best.status === "offline" ? " — offline, will queue" : ""}.`,
    );
  }

  async function attach(picked: File) {
    if (picked.size > MAX_FILE_BYTES) {
      setNote(`File is too large (${formatSize(picked.size)}) — the limit is 25 MB for now.`);
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

  function currentOptions(): SendOptions {
    const ms = EXPIRY_CHOICES[expiryIndex]?.ms;
    return {
      ...(ms !== undefined ? { expiresAt: Date.now() + ms } : {}),
      ...(deleteAfterOpening ? { deleteAfterOpening: true } : {}),
      ...(requireConfirmation ? { requireConfirmation: true } : {}),
    };
  }

  async function shareClipboard() {
    if (recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        setNote("Clipboard is empty.");
        return;
      }
      const ms = CLIPBOARD_DURATIONS[clipboardDuration]?.ms ?? CLIPBOARD_DURATIONS[1]!.ms;
      await props.engine.sendObject(
        { type: "clipboard", content: { text: clip } },
        recipients.map((d) => d.id),
        { expiresAt: Date.now() + ms, deleteAfterOpening: true },
      );
      setNote(
        `Clipboard shared with ${recipients.map((d) => d.name).join(", ")} — erases itself after ${CLIPBOARD_DURATIONS[clipboardDuration]?.label ?? "a few minutes"} or first paste.`,
      );
    } catch (err) {
      setNote(
        `Couldn't read the clipboard: ${err instanceof Error ? err.message : err}. Your browser may need permission — try again after granting clipboard access.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const content = text.trim();
    if ((!content && !file) || recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const recipientIds = recipients.map((d) => d.id);
      const options = currentOptions();
      if (file) {
        await props.engine.sendObject(
          {
            type: file.mimeType.startsWith("image/") ? "image" : "file",
            content: file,
          },
          recipientIds,
          options,
        );
        setFile(null);
      }
      if (content) {
        const objectType = type === "auto" ? detectType(content) : type;
        if (objectType === "checklist") {
          const items = content
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => ({ id: crypto.randomUUID(), text: line, done: false }));
          await props.engine.sendObject(
            { type: "checklist", content: { items } },
            recipientIds,
            options,
          );
        } else {
          await props.engine.sendObject(
            { type: objectType, content: { text: content } },
            recipientIds,
            options,
          );
        }
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
        placeholder={
          type === "checklist"
            ? "One checklist item per line…"
            : "Paste a link, command, snippet, or note…"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <select value={type} onChange={(e) => setType(e.target.value as MeshObjectType | "auto")}>
        <option value="auto">Auto-detect type</option>
        <option value="text">Text</option>
        <option value="link">Link</option>
        <option value="code">Code / command</option>
        <option value="checklist">Checklist (one item per line)</option>
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
          <span className="badge">＋ attach image or file (up to 25 MB)</span>
        </label>
      )}
      <div className="actions">
        <button
          className="ghost"
          disabled={busy || recipients.length === 0}
          onClick={() => void shareClipboard()}
        >
          📋 Share clipboard
        </button>
        <select
          value={clipboardDuration}
          onChange={(e) => setClipboardDuration(Number(e.target.value))}
        >
          {CLIPBOARD_DURATIONS.map((choice, i) => (
            <option key={choice.label} value={i}>
              for {choice.label}
            </option>
          ))}
        </select>
      </div>
      {others.length === 0 ? (
        <p className="muted">Pair another device to send things to it.</p>
      ) : (
        <div className="stack">
          <div className="actions">
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as DeviceCapability)}
            >
              {CAPABILITY_CHOICES.map((cap) => (
                <option key={cap} value={cap}>
                  {cap}
                </option>
              ))}
            </select>
            <button className="ghost" onClick={() => void routeToCapability()}>
              Route to device with this capability
            </button>
          </div>
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
      <select value={expiryIndex} onChange={(e) => setExpiryIndex(Number(e.target.value))}>
        {EXPIRY_CHOICES.map((choice, i) => (
          <option key={choice.label} value={i}>
            {choice.label}
          </option>
        ))}
      </select>
      <label className="check">
        <input
          type="checkbox"
          checked={deleteAfterOpening}
          onChange={(e) => setDeleteAfterOpening(e.target.checked)}
        />
        Delete after opening
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={requireConfirmation}
          onChange={(e) => setRequireConfirmation(e.target.checked)}
        />
        Require confirmation before delivery counts as accepted
      </label>
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
