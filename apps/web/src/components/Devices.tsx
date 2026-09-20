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
import { DevicesIcon } from "./mesh-icons.js";

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
        <div className="grid gap-2 sm:grid-cols-2">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center gap-2.5 rounded-md border border-border bg-card p-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background">
                <DevicesIcon className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {device.name}
                  {device.id === props.me.deviceId && <span className="ml-1.5 text-xs text-muted-foreground">(this device)</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground capitalize">
                  {device.type} · {device.status === "online" ? "Online" : lastSeen(device.lastSeenAt)}
                </p>
              </div>
              <span className={`size-1.5 shrink-0 rounded-full ${device.status === "online" ? "bg-success" : "bg-muted-foreground/45"}`} />
              {isOwner && device.id !== props.me.deviceId && (
                <Button size="sm" variant="ghost" onClick={() => void remove(device.id, device.name)}>
                  Remove
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border bg-card p-3">
        <p className="text-sm font-medium">This device's capabilities</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Lets others route a send to "whichever device has X" instead of naming this device directly.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
          {CAPABILITY_CHOICES.map((cap) => (
            <label key={cap} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={props.me.capabilities.includes(cap)}
                onChange={() => void toggleCapability(cap)}
                className="size-3.5 accent-foreground"
              />
              {cap}
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
