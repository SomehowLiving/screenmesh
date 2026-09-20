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
import { Button, buttonVariants } from "./ui/button.js";
import { ArrowUpIcon, ChevronDownIcon, ClipboardIcon, PlusIcon } from "./mesh-icons.js";

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

const TYPE_CHOICES: Array<{ value: MeshObjectType | "auto"; label: string }> = [
  { value: "auto", label: "Auto-detect type" },
  { value: "text", label: "Text" },
  { value: "link", label: "Link" },
  { value: "code", label: "Code snippet" },
  { value: "command", label: "Command (for a desktop agent)" },
  { value: "checklist", label: "Checklist (one item per line)" },
  { value: "agent_task", label: "Agent task (structured, for a desktop agent)" },
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
  const [taskAction, setTaskAction] = useState("echo");
  const [taskParams, setTaskParams] = useState("{}");
  const [showMore, setShowMore] = useState(false);

  const others =
    useLiveQuery(
      () => props.db.devices.where("id").notEqual(props.me.deviceId).toArray(),
      [props.db, props.me.deviceId],
    ) ?? [];

  const allSelected = others.length > 0 && others.every((d) => selected.has(d.id));
  const recipients = others.filter((d) => selected.has(d.id));
  // Composer target select mirrors the mesh mock's single-target dropdown,
  // but "Everyone" maps onto our real multi-recipient selection model.
  const targetValue = allSelected ? "__everyone__" : (recipients[0]?.id ?? "");

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

  function selectSingleTarget(deviceId: string) {
    if (deviceId === "__everyone__") {
      setSelected(new Set(others.map((d) => d.id)));
    } else {
      setSelected(deviceId ? new Set([deviceId]) : new Set());
    }
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

  async function sendAgentTask() {
    if (recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      let params: Record<string, unknown> | undefined;
      if (taskParams.trim()) {
        const parsed: unknown = JSON.parse(taskParams);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("params must be a JSON object, e.g. {\"path\": \"/tmp/log\"}");
        }
        params = parsed as Record<string, unknown>;
      }
      await props.engine.sendObject(
        { type: "agent_task", content: { action: taskAction.trim(), ...(params ? { params } : {}) } },
        recipients.map((d) => d.id),
        currentOptions(),
      );
      setNote(
        `Task "${taskAction}" sent to ${recipients.map((d) => d.name).join(", ")} — a desktop agent there will ask for approval before running it.`,
      );
    } catch (err) {
      setNote(`Could not send task: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (type === "agent_task") return sendAgentTask();
    const content = text.trim();
    if ((!content && !file) || recipients.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const recipientIds = recipients.map((d) => d.id);
      const options = currentOptions();
      if (file) {
        await props.engine.sendObject(
          { type: file.mimeType.startsWith("image/") ? "image" : "file", content: file },
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
          await props.engine.sendObject({ type: "checklist", content: { items } }, recipientIds, options);
        } else {
          await props.engine.sendObject({ type: objectType, content: { text: content } }, recipientIds, options);
        }
        setText("");
      }
      setNote(`Sent to ${recipients.map((d) => d.name).join(", ")} — offline devices get it when they reconnect.`);
    } catch (err) {
      setNote(`Send failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  const disabled =
    busy || recipients.length === 0 || (type === "agent_task" ? !taskAction.trim() : !text.trim() && !file);

  return (
    <div className="rounded-lg border border-border bg-card p-2 shadow-[0_1px_2px_oklch(0_0_0/.04)]">
      {type === "agent_task" ? (
        <div className="space-y-2 px-1 pt-1">
          <input
            type="text"
            placeholder="action (e.g. echo, read_file, run_command)"
            value={taskAction}
            onChange={(e) => setTaskAction(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <textarea
            placeholder='params as JSON, e.g. {"command": "pnpm test"}'
            value={taskParams}
            onChange={(e) => setTaskParams(e.target.value)}
            className="min-h-14 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            Routed to a desktop agent — it never runs anything without approving the request first.
          </p>
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
          }}
          placeholder={
            type === "checklist"
              ? "One checklist item per line…"
              : type === "command"
                ? "A shell command for a desktop agent to run — it will ask before executing…"
                : "Type, paste, or drop anything here…"
          }
          className="min-h-20 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
      )}

      {file && (
        <div className="mx-1 mb-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs">
          <span className="font-medium">{file.mimeType.startsWith("image/") ? "Image" : "File"}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {file.name} ({formatSize(file.size)})
          </span>
          <button type="button" onClick={() => setFile(null)} className="text-muted-foreground hover:text-foreground">
            Remove
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <label
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label="Add attachment"
          title="Add attachment"
        >
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void attach(picked);
              e.target.value = "";
            }}
          />
          <PlusIcon />
        </label>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Share clipboard"
          title="Share clipboard"
          disabled={busy || recipients.length === 0}
          onClick={() => void shareClipboard()}
        >
          <ClipboardIcon />
        </Button>
        <span className="hidden text-[10px] text-muted-foreground sm:inline">⌘ Enter to send</span>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          More options
          <ChevronDownIcon className={`size-3 transition-transform ${showMore ? "rotate-180" : ""}`} />
        </button>
        {others.length > 0 ? (
          <select
            aria-label="Send target"
            value={targetValue}
            onChange={(e) => selectSingleTarget(e.target.value)}
            className="h-8 max-w-40 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Select target…</option>
            <option value="__everyone__">Everyone</option>
            {others.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
                {device.status === "offline" ? " (offline)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-muted-foreground">Pair a device to send to it</span>
        )}
        <Button size="sm" disabled={disabled} onClick={() => void send()}>
          Send <ArrowUpIcon />
        </Button>
      </div>

      {showMore && (
        <div className="mt-2 space-y-3 border-t border-border px-1 pt-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-muted-foreground">
              Type
              <select
                aria-label="Payload type"
                value={type}
                onChange={(e) => setType(e.target.value as MeshObjectType | "auto")}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {TYPE_CHOICES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-muted-foreground">
              Expiration
              <select
                aria-label="Expiration"
                value={expiryIndex}
                onChange={(e) => setExpiryIndex(Number(e.target.value))}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                {EXPIRY_CHOICES.map((choice, i) => (
                  <option key={choice.label} value={i}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {others.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground">Recipients</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="size-3.5 accent-foreground" />
                <strong className="font-medium">All devices</strong>
              </label>
              {others.map((device) => (
                <label key={device.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(device.id)}
                    onChange={() => toggle(device.id)}
                    className="size-3.5 accent-foreground"
                  />
                  <span className={`size-1.5 rounded-full ${device.status === "online" ? "bg-success" : "bg-muted-foreground/45"}`} />
                  {device.name}
                  {device.status === "offline" && <span className="text-muted-foreground">(queued until it resurfaces)</span>}
                </label>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <select
                  aria-label="Capability to route to"
                  value={capability}
                  onChange={(e) => setCapability(e.target.value as DeviceCapability)}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                >
                  {CAPABILITY_CHOICES.map((cap) => (
                    <option key={cap} value={cap}>
                      {cap}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="outline" onClick={() => void routeToCapability()}>
                  Route to device with this capability
                </Button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteAfterOpening}
              onChange={(e) => setDeleteAfterOpening(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            Delete after opening
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireConfirmation}
              onChange={(e) => setRequireConfirmation(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            Require confirmation before delivery counts as accepted
          </label>
        </div>
      )}

      {note && <p className="mt-2 px-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}
