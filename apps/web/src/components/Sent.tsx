import { useLiveQuery } from "dexie-react-hooks";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { LocalIdentity } from "../lib/app.js";

function preview(content: unknown): string {
  const text =
    content && typeof content === "object" && "text" in content
      ? String((content as { text: unknown }).text)
      : String(content ?? "");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function SentPanel(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  const deliveries =
    useLiveQuery(
      () =>
        props.db.deliveries
          .where("id")
          .notEqual("")
          .and((d) => d.sourceDeviceId === props.me.deviceId)
          .reverse()
          .sortBy("createdAt"),
      [props.db, props.me.deviceId],
    ) ?? [];
  const objects = useLiveQuery(() => props.db.objects.toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];

  const objectOf = (id: string) => objects.find((o) => o.id === id);
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "unknown device";

  return (
    <section className="card">
      <h2>Sent</h2>
      {deliveries.length === 0 && <p className="muted">Nothing sent yet.</p>}
      <ul className="plain">
        {deliveries.map((delivery) => (
          <li className="row" key={delivery.id} style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <p className="obj-text">{preview(objectOf(delivery.objectId)?.content)}</p>
              <div className="muted">
                to {nameOf(delivery.destinationDeviceId)} ·{" "}
                <span className={`status-${delivery.status}`}>{delivery.status}</span>
                {delivery.openedAt
                  ? ` · opened ${new Date(delivery.openedAt).toLocaleTimeString()}`
                  : delivery.deliveredAt
                    ? ` · delivered ${new Date(delivery.deliveredAt).toLocaleTimeString()}`
                    : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
