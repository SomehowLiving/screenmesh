import { useLiveQuery } from "dexie-react-hooks";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { LocalIdentity } from "../lib/app.js";
import { ArrowUpIcon } from "./mesh-icons.js";

function preview(content: unknown): string {
  const text =
    content && typeof content === "object" && "text" in content
      ? String((content as { text: unknown }).text)
      : String(content ?? "");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const STATUS_COLOR: Record<string, string> = {
  queued: "bg-warning",
  sending: "bg-warning",
  delivered: "bg-success",
  opened: "bg-success",
  expired: "bg-destructive",
  failed: "bg-destructive",
};

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

  if (deliveries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <span className="grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4">
          <ArrowUpIcon />
        </span>
        <p className="text-sm font-medium">Nothing sent yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Whatever you send from the composer above will show up here with its delivery status.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {deliveries.map((delivery) => (
        <article key={delivery.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-4">
          <div className="grid size-7 place-items-center rounded-md border border-border bg-card [&_svg]:size-3.5">
            <ArrowUpIcon />
          </div>
          <div className="min-w-0">
            <p className="text-sm">{preview(objectOf(delivery.objectId)?.content)}</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>to {nameOf(delivery.destinationDeviceId)}</span>
              <span className={`size-1 rounded-full ${STATUS_COLOR[delivery.status] ?? "bg-muted-foreground/45"}`} />
              <span className="capitalize">{delivery.status}</span>
              {delivery.openedAt
                ? <span>· opened {new Date(delivery.openedAt).toLocaleTimeString()}</span>
                : delivery.deliveredAt
                  ? <span>· delivered {new Date(delivery.deliveredAt).toLocaleTimeString()}</span>
                  : null}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
