import { useLiveQuery } from "dexie-react-hooks";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { LocalIdentity } from "../lib/app.js";

function lastSeen(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function DevicesPanel(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];

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
          </li>
        ))}
      </ul>
    </section>
  );
}
