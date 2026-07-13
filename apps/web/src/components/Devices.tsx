import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import {
  revokeDevice,
  type LocalIdentity,
  type LocalWorkspace,
} from "../lib/app.js";

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
}) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const [note, setNote] = useState<string | null>(null);
  const isOwner = props.me.deviceId === props.workspace.ownerDeviceId;

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
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
