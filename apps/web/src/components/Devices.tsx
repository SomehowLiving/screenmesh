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
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
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
    if (!window.confirm(`Remove "${name}" from this workspace? It will lose relay access immediately.`)) {
      return;
    }
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
    const next = current.includes(cap)
      ? current.filter((c) => c !== cap)
      : [...current, cap];
    try {
      const updated = await setCapabilities(props.db, props.me, props.workspace, next);
      props.onIdentityChange(updated);
    } catch (err) {
      setNote(`Could not update capabilities: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <section className="card">
      <h2>Devices</h2>
      {devices.length === 0 && (
        <p className="muted">No devices yet — pair one with the QR code.</p>
      )}
      <ul className="plain">
        {devices.map((device) => (
          <li className="row" key={device.id}>
            <span className={`dot ${device.status}`} />
            <span style={{ flex: 1 }}>
              {device.name}
              {device.id === props.me.deviceId && (
                <span className="muted"> · this device</span>
              )}
            </span>
            <span className="muted">
              {device.status === "online" ? "online" : lastSeen(device.lastSeenAt)}
            </span>
            <span className="badge">{device.type}</span>
            {device.capabilities?.map((cap) => (
              <span className="badge" key={cap}>
                {cap}
              </span>
            ))}
            {isOwner && device.id !== props.me.deviceId && (
              <button
                className="ghost"
                onClick={() => void remove(device.id, device.name)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="stack">
        <p className="muted">
          This device's capabilities — lets others route a send to
          "whichever device has X" instead of naming this device directly.
        </p>
        <div className="actions">
          {CAPABILITY_CHOICES.map((cap) => (
            <label className="check" key={cap}>
              <input
                type="checkbox"
                checked={props.me.capabilities.includes(cap)}
                onChange={() => void toggleCapability(cap)}
              />
              {cap}
            </label>
          ))}
        </div>
      </div>
      {carrying.length > 0 && (
        <p className="muted">
          Carrying {carrying.length} item{carrying.length === 1 ? "" : "s"} for{" "}
          {[...new Set(carrying.map((b) => nameOf(b.destinationDeviceId)))].join(", ")} —
          delivered automatically once reachable.
        </p>
      )}
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
