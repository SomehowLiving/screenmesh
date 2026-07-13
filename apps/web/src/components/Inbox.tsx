import { useLiveQuery } from "dexie-react-hooks";
import type { FileContent, MeshObject, TextContent } from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
import type { LocalIdentity } from "../lib/app.js";

function isFileObject(object: MeshObject): boolean {
  return object.type === "image" || object.type === "file";
}

function textOf(content: unknown): string {
  if (content && typeof content === "object" && "text" in content) {
    return String((content as TextContent).text);
  }
  return String(content ?? "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadFile(file: FileContent) {
  const bytes = Uint8Array.from(atob(file.dataB64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  URL.revokeObjectURL(url);
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
          const file = isFileObject(object) ? (object.content as FileContent) : null;
          const text = file ? null : textOf(object.content);
          return (
            <li className="row" key={object.id} style={{ alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div className="muted">
                  <span className="badge">{object.type}</span>{" "}
                  from {nameOf(object.createdBy)} ·{" "}
                  {new Date(object.createdAt).toLocaleTimeString()}
                </div>
                {object.type === "image" && file && (
                  <img
                    src={`data:${file.mimeType};base64,${file.dataB64}`}
                    alt={file.name}
                    style={{ maxWidth: "100%", borderRadius: 8, margin: "0.4rem 0" }}
                    onLoad={() => void props.engine.markOpened(object.id)}
                  />
                )}
                {file && (
                  <p className="obj-text">
                    {file.name} <span className="muted">({formatSize(file.size)})</span>
                  </p>
                )}
                {text !== null && (
                  <p className={`obj-text ${object.type === "code" ? "mono" : ""}`}>{text}</p>
                )}
                <div className="actions">
                  {file && (
                    <button
                      className="ghost"
                      onClick={() => {
                        downloadFile(file);
                        void props.engine.markOpened(object.id);
                      }}
                    >
                      Download
                    </button>
                  )}
                  {text !== null && (
                    <button
                      className="ghost"
                      onClick={async () => {
                        await navigator.clipboard.writeText(text);
                        await props.engine.markOpened(object.id);
                      }}
                    >
                      Copy
                    </button>
                  )}
                  {object.type === "link" && text !== null && (
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
