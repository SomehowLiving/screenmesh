import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  toBase64,
  type Device,
  type DeviceCapability,
  type FileContent,
  type MeshObjectType,
  type SendOptions,
} from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";
import { Button, buttonVariants } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, DeviceTypeIcon, DevicesIcon, PlusIcon } from "./mesh-icons.js";

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
const TYPE_CHOICES: Array<{ value: MeshObjectType | "auto"; label: string }> = [
  { value: "auto", label: "Auto-detect type" },
  { value: "text", label: "Text" },
  { value: "document", label: "Document" },
  { value: "link", label: "Link" },
  { value: "code", label: "Code snippet" },
  { value: "command", label: "Command (for a desktop agent)" },
  { value: "checklist", label: "Checklist (one item per line)" },
  { value: "agent_task", label: "Agent task (structured, for a desktop agent)" },
];

function TargetPicker(props: {
  devices: Device[];
  targetValue: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = props.targetValue === "__everyone__"
    ? null
    : props.devices.find((device) => device.id === props.targetValue);
  const label = props.targetValue === "__everyone__" ? "Everyone" : current?.name ?? "Select recipients";

  function choose(id: string) {
    props.onChange(id);
    setOpen(false);
  }

  return (
    <div className="relative min-w-0 flex-1 sm:flex-none">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs shadow-sm transition-colors hover:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-ring sm:min-w-44"
      >
        {current ? <DeviceTypeIcon deviceType={current.type} className="size-4 shrink-0 text-muted-foreground" /> : <DevicesIcon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDownIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-64 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Send to</p>
          <TargetOption active={props.targetValue === "__everyone__"} icon={<DevicesIcon className="size-4" />} label="Everyone" detail={`All ${props.devices.length} paired devices`} onClick={() => choose("__everyone__")} />
          <div className="my-1 border-t border-border" />
          {props.devices.map((device) => (
            <TargetOption
              key={device.id}
              active={props.targetValue === device.id}
              icon={<DeviceTypeIcon deviceType={device.type} className="size-4" />}
              label={device.name}
              detail={`${device.type} / ${device.status === "online" ? "Online" : "Offline"}`}
              offline={device.status === "offline"}
              onClick={() => choose(device.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TargetOption(props: { active: boolean; icon: React.ReactNode; label: string; detail: string; offline?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={props.onClick} className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${props.active ? "bg-accent" : "hover:bg-accent/70"}`}>
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{props.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{props.label}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className={`size-1.5 rounded-full ${props.offline ? "bg-muted-foreground/45" : "bg-success"}`} />{props.detail}</span>
      </span>
      {props.active && <CheckIcon className="size-4 shrink-0" />}
    </button>
  );
}

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
  const [attachmentName, setAttachmentName] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiryIndex, setExpiryIndex] = useState(0);
  const [deleteAfterOpening, setDeleteAfterOpening] = useState(false);
  const [requireConfirmation, setRequireConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
  const suggested = useMemo(() => {
    const effectiveType = type === "auto" ? detectType(text) : type;
    const needed = effectiveType === "code" || effectiveType === "command" || effectiveType === "agent_task"
      ? "terminal"
      : effectiveType === "link" ? "browser" : undefined;
    const capabilityMatches = needed ? others.filter((device) => device.capabilities?.includes(needed)) : [];
    const viewingMatches = effectiveType === "image" ? others.filter((device) => device.type === "display" || device.type === "tablet") : [];
    const candidate = [...capabilityMatches.filter((device) => device.status === "online"), ...capabilityMatches, ...viewingMatches.filter((device) => device.status === "online"), ...viewingMatches][0];
    return candidate ? { device: candidate, reason: needed ? `${needed} available` : "suited to viewing" } : null;
  }, [others, text, type]);

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
    setAttachmentName(picked.name);
    setNote(null);
  }

  /** Universal capture starts in the normal composer: users can review the
   * detected type, destination, lifecycle, and approval options before any
   * data leaves this device. */
  async function captureClipboard() {
    try {
      const captured = await navigator.clipboard.readText();
      if (!captured.trim()) {
        setNote("Clipboard is empty.");
        return;
      }
      setText(captured);
      setType("auto");
      setFile(null);
      setAttachmentName("");
      setNote("Captured from clipboard. Choose where it should go when you are ready.");
    } catch (err) {
      setNote(`Couldn't read the clipboard: ${err instanceof Error ? err.message : "permission was not granted"}.`);
    }
  }

  function currentOptions(): SendOptions {
    const ms = EXPIRY_CHOICES[expiryIndex]?.ms;
    return {
      ...(ms !== undefined ? { expiresAt: Date.now() + ms } : {}),
      ...(deleteAfterOpening ? { deleteAfterOpening: true } : {}),
      ...(requireConfirmation ? { requireConfirmation: true } : {}),
    };
  }

  /* Clipboard quick-share is intentionally not exposed in the composer. */
  /*
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
      const offline = recipients.filter((device) => device.status === "offline");
      if (offline.length) {
        setNote(`Queued safely for ${offline.map((device) => device.name).join(", ")}. It will deliver automatically when a trusted route opens.`);
      }
    } catch (err) {
      setNote(
        `Couldn't read the clipboard: ${err instanceof Error ? err.message : err}. Your browser may need permission — try again after granting clipboard access.`,
      );
    } finally {
      setBusy(false);
    }
  }

  */
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
      const offline = recipients.filter((device) => device.status === "offline");
      if (file) {
        await props.engine.sendObject(
          { type: file.mimeType.startsWith("image/") ? "image" : "file", content: { ...file, name: attachmentName.trim() || file.name } },
          recipientIds,
          options,
        );
        setFile(null);
        setAttachmentName("");
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
          await props.engine.sendObject(
            { type: objectType, content: objectType === "document" ? { text: content, title: documentTitle.trim() || undefined } : { text: content } },
            recipientIds,
            options,
          );
        }
        setText("");
        setDocumentTitle("");
        if (offline.length) {
          setNote(`Queued safely for ${offline.map((device) => device.name).join(", ")}. It will deliver automatically when a trusted route opens.`);
        }
      }
      if (offline.length === 0) {
        setNote(`Sent securely to ${recipients.map((device) => device.name).join(", ")}.`);
      }
    } catch (err) {
      setNote(`Send failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  }

  const disabled =
    busy || recipients.length === 0 || (type === "agent_task" ? !taskAction.trim() : !text.trim() && !file);

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-[0_1px_2px_oklch(0_0_0/.04)] transition-shadow focus-within:shadow-[0_4px_16px_oklch(0_0_0/.06)]">
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
        <>
        {type === "document" && <input value={documentTitle} onChange={(event) => setDocumentTitle(event.target.value)} placeholder="Document title (optional)" className="mb-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring" />}
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
          className="min-h-28 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground md:min-h-32"
        />
        </>
      )}

      {file && (
        <div className="mx-1 mb-1 flex flex-wrap items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs">
          <span className="font-medium">{file.mimeType.startsWith("image/") ? "Image" : "File"}</span>
          <input aria-label="Attachment name" value={attachmentName} onChange={(event) => setAttachmentName(event.target.value)} placeholder={file.name} className="h-7 min-w-32 flex-1 rounded border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring" />
          <span className="text-muted-foreground">{formatSize(file.size)}</span>
          <button type="button" onClick={() => { setFile(null); setAttachmentName(""); }} className="text-muted-foreground hover:text-foreground">
            Remove
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-1 pt-3 sm:gap-y-2">
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
        <Button variant="ghost" size="sm" className="hidden text-muted-foreground sm:inline-flex" onClick={() => void captureClipboard()}>
          Capture
        </Button>
        <span className="hidden text-[10px] text-muted-foreground md:inline">⌘ Enter to send</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto sm:hidden"
          aria-label="More options"
          title="More options"
          onClick={() => setShowMore((v) => !v)}
        >
          <ChevronDownIcon className={showMore ? "rotate-180" : ""} />
        </Button>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="ml-auto hidden items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex"
        >
          More options
          <ChevronDownIcon className={`size-3 transition-transform ${showMore ? "rotate-180" : ""}`} />
        </button>
        {others.length > 0 ? (
          <TargetPicker devices={others} targetValue={targetValue} onChange={selectSingleTarget} />
        ) : (
          <span className="flex-1 text-[11px] text-muted-foreground sm:flex-none">No devices paired</span>
        )}
        <Button size="sm" disabled={disabled} onClick={() => void send()}>
          Send <ArrowUpIcon />
        </Button>
      </div>

      {suggested && recipients.length === 0 && (
        <button type="button" onClick={() => selectSingleTarget(suggested.device.id)} className="mt-2 flex items-center gap-2 rounded-md px-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <span className="size-1.5 rounded-full bg-success" /> Suggested: <span className="font-medium text-foreground">{suggested.device.name}</span> · {suggested.reason}
        </button>
      )}

      {showMore && (
        <div className="mt-2 space-y-3 border-t border-border px-1 pt-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-muted-foreground">
              Type
              <SelectMenu
                className="mt-1"
                ariaLabel="Payload type"
                value={type}
                onValueChange={(value) => setType(value as MeshObjectType | "auto")}
                options={TYPE_CHOICES}
              />
            </label>
            <label className="text-[11px] text-muted-foreground">
              Expiration
              <SelectMenu
                className="mt-1"
                ariaLabel="Expiration"
                value={String(expiryIndex)}
                onValueChange={(value) => setExpiryIndex(Number(value))}
                options={EXPIRY_CHOICES.map((choice, index) => ({ value: String(index), label: choice.label }))}
              />
            </label>
          </div>

          {others.length > 0 && (
            <div className="rounded-md bg-muted/45 p-2.5">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">Route by capability</p>
              <div className="flex flex-wrap items-center gap-2">
                <SelectMenu
                  className="w-40"
                  ariaLabel="Capability to route to"
                  value={capability}
                  onValueChange={(value) => setCapability(value as DeviceCapability)}
                  options={CAPABILITY_CHOICES.map((cap) => ({ value: cap, label: cap.replace("-", " ") }))}
                />
                <Button size="sm" variant="outline" onClick={() => void routeToCapability()}>
                  Route to device with this capability
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${deleteAfterOpening ? "border-foreground bg-accent" : "border-border hover:border-foreground/30"}`}>
              <input type="checkbox" checked={deleteAfterOpening} onChange={(e) => setDeleteAfterOpening(e.target.checked)} className="sr-only" />
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${deleteAfterOpening ? "border-foreground bg-foreground text-background" : "border-input bg-background"}`}>
                {deleteAfterOpening && <CheckIcon className="size-3" />}
              </span>
              <span>
                <span className="block text-xs font-medium">Delete after opening</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">Remove it once the recipient opens it.</span>
              </span>
            </label>
            <label className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${requireConfirmation ? "border-foreground bg-accent" : "border-border hover:border-foreground/30"}`}>
              <input type="checkbox" checked={requireConfirmation} onChange={(e) => setRequireConfirmation(e.target.checked)} className="sr-only" />
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border ${requireConfirmation ? "border-foreground bg-foreground text-background" : "border-input bg-background"}`}>
                {requireConfirmation && <CheckIcon className="size-3" />}
              </span>
              <span>
                <span className="block text-xs font-medium">Require confirmation</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">Count delivery only after the recipient accepts.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      {note && <p className="mt-2 px-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}
