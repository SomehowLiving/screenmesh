import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Delivery, MeshEvent, MeshObject, Operation } from "@screenmesh/protocol";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { LocalIdentity } from "../lib/app.js";
import { ActivityIcon } from "./mesh-icons.js";

type ActivityCategory = "All" | "Transfers" | "Devices" | "Network" | "Security";

type ActivityEvent = {
  id: string;
  category: Exclude<ActivityCategory, "All">;
  timestamp: number;
  title: string;
  detail: string;
  reason?: string;
  tone: "success" | "muted" | "warning" | "info";
};

const FILTERS: ActivityCategory[] = ["All", "Transfers", "Devices", "Network", "Security"];

function deviceName(devices: Array<{ id: string; name: string }>, id: string, me: LocalIdentity) {
  return id === me.deviceId ? me.name : devices.find((device) => device.id === id)?.name ?? "Unknown device";
}

function objectName(object: MeshObject | undefined) {
  if (!object) return "Payload";
  if (object.type === "file" || object.type === "image") {
    const content = object.content as { name?: string };
    return content.name ?? "File";
  }
  return object.type.replace("_", " ");
}

function deliveryEvent(delivery: Delivery, objects: MeshObject[], devices: Array<{ id: string; name: string }>, me: LocalIdentity): ActivityEvent {
  const status = delivery.status;
  const timestamp = delivery.openedAt ?? delivery.deliveredAt ?? delivery.createdAt;
  const source = deviceName(devices, delivery.sourceDeviceId, me);
  const target = deviceName(devices, delivery.destinationDeviceId, me);
  const name = objectName(objects.find((object) => object.id === delivery.objectId));
  const labels: Record<string, string> = {
    queued: "Payload queued",
    sending: "Payload sending",
    delivered: "Payload delivered",
    opened: "Payload opened",
    pending: "Delivery awaiting confirmation",
    rejected: "Delivery declined",
    expired: "Payload expired",
    failed: "Delivery failed",
  };
  return {
    id: `delivery-${delivery.id}`,
    category: "Transfers",
    timestamp,
    title: labels[status] ?? "Payload updated",
    detail: `${name} · ${source} → ${target}`,
    ...(status === "queued" ? { reason: "The destination is not currently reachable. ScreenMesh will retry automatically when a trusted route opens." } : {}),
    tone: status === "delivered" || status === "opened" ? "success" : status === "queued" || status === "pending" ? "warning" : status === "failed" || status === "expired" ? "muted" : "info",
  };
}

function operationEvent(operation: Operation, devices: Array<{ id: string; name: string }>, me: LocalIdentity): ActivityEvent | null {
  const actor = deviceName(devices, operation.deviceId, me);
  const map: Partial<Record<Operation["type"], Omit<ActivityEvent, "id" | "timestamp">>> = {
    REVOKE_DEVICE: { category: "Security", title: "Device access revoked", detail: `${actor} removed a device from the workspace`, tone: "warning" },
    CARRY_BUNDLE: { category: "Network", title: "Payload handed to a carrier", detail: `${actor} is keeping an encrypted bundle available`, tone: "info" },
    CONTINUE_ON_DEVICE: { category: "Transfers", title: "Continue on device requested", detail: `${actor} asked another device to open an object`, tone: "info" },
  };
  const event = map[operation.type];
  return event ? { ...event, id: `operation-${operation.operationId}`, timestamp: operation.timestamp } : null;
}

export function ActivityPanel(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  const [filter, setFilter] = useState<ActivityCategory>("All");
  const [expanded, setExpanded] = useState<string | null>(null);
  const deliveries = useLiveQuery(() => props.db.deliveries.toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const objects = useLiveQuery(() => props.db.objects.toArray(), [props.db]) ?? [];
  const operations = useLiveQuery(() => props.db.operations.toArray(), [props.db]) ?? [];
  const ledger = useLiveQuery(() => props.db.events.orderBy("timestamp").reverse().toArray(), [props.db]) ?? [];

  const events = useMemo(() => {
    const recorded = ledger.map((event: MeshEvent): ActivityEvent => ({
      id: event.id,
      category: event.category === "transfer" ? "Transfers" : event.category === "device" ? "Devices" : event.category === "network" ? "Network" : "Security",
      timestamp: event.timestamp,
      title: event.title,
      detail: event.detail,
      ...(event.type === "delivery-queued" ? { reason: "No active route was available. The encrypted bundle stays on this device and will retry automatically." } : {}),
      tone: event.type.includes("fallback") || event.type.includes("unavailable") || event.type.includes("disconnected") || event.type.includes("queued")
        ? "warning"
        : event.type.includes("offline")
          ? "muted"
          : event.category === "security" ? "info" : "success",
    }));
    const deliveryEvents = ledger.length === 0 ? deliveries.map((delivery) => deliveryEvent(delivery, objects, devices, props.me)) : [];
    const deviceEvents: ActivityEvent[] = devices.map((device) => ({
      id: `device-${device.id}-${device.lastSeenAt}`,
      category: "Devices",
      timestamp: device.lastSeenAt,
      title: device.status === "online" ? "Device online" : "Device offline",
      detail: `${device.name} · ${device.type}`,
      tone: device.status === "online" ? "success" : "muted",
    }));
    const operationEvents = operations.map((operation) => operationEvent(operation, devices, props.me)).filter((event): event is ActivityEvent => event !== null);
    return [...recorded, ...deliveryEvents, ...(ledger.length === 0 ? deviceEvents : []), ...operationEvents].sort((a, b) => b.timestamp - a.timestamp);
  }, [ledger, deliveries, devices, objects, operations, props.me]);

  const visible = filter === "All" ? events : events.filter((event) => event.category === filter);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Activity</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">What changed in your mesh, and why.</p>
        </div>
        <span className="flex items-center gap-1.5 rounded bg-success/10 px-2 py-1 text-[10px] font-medium text-success"><span className="size-1.5 rounded-full bg-success" />LIVE</span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{events.length} event{events.length === 1 ? "" : "s"} recorded on this device</p>

      <div className="mt-4 flex flex-wrap gap-1 rounded-lg border border-border bg-muted/35 p-1">
        {FILTERS.map((item) => (
          <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${filter === item ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {item}
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <div className="grid place-items-center py-20 text-center">
            <div><span className="mx-auto grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground"><ActivityIcon className="size-4" /></span><p className="mt-3 text-sm font-medium">No {filter === "All" ? "activity" : filter.toLowerCase()} yet</p><p className="mt-1 text-xs text-muted-foreground">Mesh events recorded on this device will appear here.</p></div>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border bg-card">
            {visible.map((event) => {
              const open = expanded === event.id;
              return (
                <button key={event.id} type="button" onClick={() => setExpanded(open ? null : event.id)} className="w-full px-4 py-3 text-left hover:bg-muted/35">
                  <div className="grid grid-cols-[12px_48px_minmax(0,1fr)] gap-2.5">
                    <span className={`mt-1.5 size-2 rounded-full ${event.tone === "success" ? "bg-success" : event.tone === "warning" ? "bg-warning" : event.tone === "info" ? "bg-info" : "bg-muted-foreground/45"}`} />
                    <span className="pt-0.5 font-mono text-[10px] text-muted-foreground">{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="min-w-0"><span className="block text-xs font-medium">{event.title}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{event.detail}</span>{open && event.reason && <span className="mt-3 block rounded-md bg-muted px-3 py-2 text-[11px] leading-4 text-muted-foreground"><strong className="font-medium text-foreground">Why?</strong><br />{event.reason}</span>}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
