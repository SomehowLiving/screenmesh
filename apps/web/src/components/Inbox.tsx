import { useLiveQuery } from "dexie-react-hooks";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";

function textOf(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return String(content ?? "");
}

export function InboxPanel(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  engine: MeshEngine;
}) {
  const objects =
    useLiveQuery(
      () =>
        props.db.objects
          .where("workspaceId")
          .notEqual("")
          .and((o) => o.createdBy !== props.me.deviceId)
          .reverse()
          .sortBy("createdAt"),
      [props.db, props.me.deviceId],
    ) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "unknown device";

  return (
    <section className="card">
      <h2>Inbox</h2>
      {objects.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul className="plain">
        {objects.map((object) => {
          const text = textOf(object.content);
          return (
            <li className="row" key={object.id} style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div className="muted">
                  <span className="badge">{object.type}</span>{" "}
                  from {nameOf(object.createdBy)} ·{" "}
                  {new Date(object.createdAt).toLocaleTimeString()}
                </div>
                <p className={`obj-text ${object.type === "code" ? "mono" : ""}`}>{text}</p>
                <div className="actions">
                  <button
                    className="ghost"
                    onClick={async () => {
                      await navigator.clipboard.writeText(text);
                      await props.engine.markOpened(object.id);
                    }}
                  >
                    Copy
                  </button>
                  {object.type === "link" && (
                    <button
                      className="ghost"
                      onClick={() => {
                        window.open(text, "_blank", "noopener");
                        void props.engine.markOpened(object.id);
                      }}
                    >
                      Open
                    </button>
                  )}
                  <button
                    className="ghost"
                    onClick={() => void props.engine.deleteObjectLocal(object.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
