import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { DeviceCapability } from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import {
  revokeDevice,
  setCapabilities,
  type LocalIdentity,
  type LocalWorkspace,
} from "../lib/app.js";
import { Button } from "./ui/button.js";
import { DeviceTypeIcon } from "./mesh-icons.js";

const CAPABILITY_CHOICES: DeviceCapability[] = [
  "terminal",
  "filesystem",
  "camera",
  "microphone",
  "gps",
  "browser",
  "local-models",
];

function lastSeen(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function DevicesPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  workspace: LocalWorkspace;
  engine: MeshEngine;
  onIdentityChange: (me: LocalIdentity) => void;
}) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const carrying = useLiveQuery(() => props.db.carried.toArray(), [props.db]) ?? [];
  const [note, setNote] = useState<string | null>(null);
  const isOwner = props.me.deviceId === props.workspace.ownerDeviceId;
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "an offline device";

  async function remove(deviceId: string, name: string) {
    if (!window.confirm(`Remove "${name}" from this workspace? It will lose access immediately.`)) return;
    try {
      setNote(null);
      await revokeDevice(props.me, props.workspace, props.engine, deviceId);
      setNote(`${name} was removed.`);
    } catch (err) {
      setNote(`Could not remove device: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function toggleCapability(cap: DeviceCapability) {
    const current = props.me.capabilities;
    const next = current.includes(cap) ? current.filter((c) => c !== cap) : [...current, cap];
    try {
      const updated = await setCapabilities(props.db, props.me, props.workspace, next);
      props.onIdentityChange(updated);
    } catch (err) {
      setNote(`Could not update capabilities: ${err instanceof Error ? err.message : err}`);
    }
  }

  const online = devices.filter((d) => d.status === "online");

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{online.length} online · {devices.length} paired</p>

      {devices.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No devices paired yet — use "Pair device" to add one.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {devices.map((device) => (
            <div key={device.id} className="group flex min-h-20 items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/20">
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-foreground">
                <DeviceTypeIcon deviceType={device.type} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  {device.id === props.me.deviceId && <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">This device</span>}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground capitalize">{device.type}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={`size-1.5 rounded-full ${device.status === "online" ? "bg-success" : "bg-muted-foreground/45"}`} />
                {device.status === "online" ? "Online" : lastSeen(device.lastSeenAt)}
              </span>
              {isOwner && device.id !== props.me.deviceId && (
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-destructive" onClick={() => void remove(device.id, device.name)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Capability routing</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
          Lets others route a send to "whichever device has X" instead of naming this device directly.
            </p>
          </div>
          <span className="hidden rounded bg-muted px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:block">This device</span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {CAPABILITY_CHOICES.map((cap) => (
            <label key={cap} className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${props.me.capabilities.includes(cap) ? "border-foreground bg-foreground text-background" : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}>
              <input
                type="checkbox"
                checked={props.me.capabilities.includes(cap)}
                onChange={() => void toggleCapability(cap)}
                className="sr-only"
              />
              <span className={`size-1.5 rounded-full ${props.me.capabilities.includes(cap) ? "bg-background" : "bg-muted-foreground/45"}`} />
              <span className="capitalize">{cap.replace("-", " ")}</span>
            </label>
          ))}
        </div>
      </div>

      {carrying.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Carrying {carrying.length} item{carrying.length === 1 ? "" : "s"} for{" "}
          {[...new Set(carrying.map((b) => nameOf(b.destinationDeviceId)))].join(", ")} — delivered automatically once reachable.
        </p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
