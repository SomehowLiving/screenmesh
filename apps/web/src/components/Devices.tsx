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
  if (mins < 1) return "JUST NOW";
  if (mins < 60) return `${mins}M AGO`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}H AGO` : `${Math.round(hours / 24)}D AGO`;
}

function DeviceIcon({ type }: { type: string }) {
  const icon =
    type === "phone" ? "▯" :
    type === "tablet" ? "▯" :
    type === "desktop" || type === "display" ? "▱" :
    "▱";
  return <span className="device-icon">{icon}</span>;
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
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "OFFLINE NODE";

  async function remove(deviceId: string, name: string) {
    if (!window.confirm(`Revoke "${name}" from this channel? Access is cut immediately.`)) return;
    try {
      setNote(null);
      await revokeDevice(props.me, props.workspace, props.engine, deviceId);
      setNote(`${name} was revoked.`);
    } catch (err) {
      setNote(`Could not revoke node: ${err instanceof Error ? err.message : err}`);
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

  const online = devices.filter((d) => d.status === "online");
  const offline = devices.filter((d) => d.status !== "online");
  const ordered = [...online, ...offline];

  return (
    <div className="device-mesh">
      <div className="mesh-count">
        {online.length} ONLINE <span>/</span> {devices.length} NODES
      </div>

      <div className="mesh-stage">
        <div className="mesh-rings" />

        <div className="mesh-core">
          <div className="core-lock">⌑</div>
          <strong>SECURE MESH</strong>
          <span>X25519 / AES-GCM</span>
          <span>{online.length} NODES ACTIVE</span>
        </div>

        {ordered.slice(0, 4).map((device, index) => {
          const positions = [
            "node-top",
            "node-left",
            "node-right",
            "node-bottom",
          ];
          return (
            <div
              className={`mesh-node ${positions[index] ?? "node-bottom"} ${
                device.status === "online" ? "online" : "offline"
              }`}
              key={device.id}
            >
              <div className="node-connector" />
              <div className="node-card">
                <DeviceIcon type={device.type} />
                <div className="node-info">
                  <strong>{device.name}</strong>
                  <span>{device.type.toUpperCase()}</span>
                  <span className="node-state">
                    <i className="status-led" />
                    {device.status === "online" ? "ONLINE" : lastSeen(device.lastSeenAt)}
                  </span>
                </div>
              </div>
              {index < 3 && (
                // No measured per-connection latency is exposed by DevicesPanel's
                // API yet (see the redesign README) — "LIVE" rather than a
                // fabricated number, so this never claims a precision we don't have.
                <span className="latency">
                  {device.status === "online" ? "LIVE" : "QUEUED"}
                </span>
              )}
            </div>
          );
        })}

        {devices.length === 0 && (
          <div className="empty-mesh">
            <span>NO NODES</span>
            <small>PAIR A DEVICE TO INITIALIZE THE MESH</small>
          </div>
        )}
      </div>

      <div className="mesh-footer">
        <div>
          <span className="status-led" /> E2EE ACTIVE
          <small>All traffic is encrypted at the application layer.</small>
        </div>
        <div className="mesh-route">ROUTING :: AUTO / MULTI-TRANSPORT</div>
      </div>

      <details className="mesh-advanced">
        <summary>NODE CAPABILITIES / ADMINISTRATION</summary>
        <div className="advanced-body">
          <p className="muted">
            Advertised capabilities allow routing to whichever trusted node has the required capability.
          </p>
          <div className="capability-grid">
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

          {isOwner && devices.filter((d) => d.id !== props.me.deviceId).length > 0 && (
            <div className="admin-nodes">
              {devices
                .filter((d) => d.id !== props.me.deviceId)
                .map((device) => (
                  <div className="admin-node" key={device.id}>
                    <span>{device.name}</span>
                    <button className="ghost" onClick={() => void remove(device.id, device.name)}>
                      REVOKE
                    </button>
                  </div>
                ))}
            </div>
          )}

          {carrying.length > 0 && (
            <p className="muted">
              {carrying.length} sealed payload{carrying.length === 1 ? "" : "s"} queued for{" "}
              {[...new Set(carrying.map((b) => nameOf(b.destinationDeviceId)))].join(", ")}.
            </p>
          )}

          {note && <p className="muted">{note}</p>}
        </div>
      </details>
    </div>
  );
}
