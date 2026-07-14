import Dexie, { type Table } from "dexie";
import type {
  Delivery,
  DeliveryBundle,
  Device,
  MeshObject,
  Operation,
  Workspace,
} from "@screenmesh/protocol";

/** Key/value settings: identity, workspace config, sequence counters. */
export interface SettingEntry {
  key: string;
  value: unknown;
}

/** Replay protection: message IDs we have already processed. */
export interface SeenMessage {
  messageId: string;
  seenAt: number;
}

/** Persisted Yjs document state for collaboratively edited objects. */
export interface YDocState {
  objectId: string;
  state: Uint8Array;
}

/**
 * Local-first persistence (IndexedDB via Dexie). Every device stores its
 * own copy of the relevant workspace data; the server is never the primary
 * database. See docs/Architecture.md §2 (Layer 3).
 */
export class ScreenMeshDb extends Dexie {
  devices!: Table<Device, string>;
  workspaces!: Table<Workspace, string>;
  objects!: Table<MeshObject, string>;
  operations!: Table<Operation, string>;
  deliveries!: Table<Delivery, string>;
  /** Pending encrypted bundles awaiting a route (Eventual mode). */
  outbox!: Table<DeliveryBundle, string>;
  /** Encrypted bundles this device is carrying for other devices. */
  carried!: Table<DeliveryBundle, string>;
  settings!: Table<SettingEntry, string>;
  seen!: Table<SeenMessage, string>;
  ydocs!: Table<YDocState, string>;

  constructor(name = "screenmesh") {
    super(name);
    this.version(1).stores({
      devices: "id, status, trusted",
      workspaces: "id, mode, expiresAt",
      objects: "id, workspaceId, type, updatedAt, expiresAt",
      operations: "operationId, workspaceId, deviceId, timestamp",
      deliveries: "id, objectId, destinationDeviceId, status",
      outbox: "bundleId, destinationDeviceId, expiresAt",
      carried: "bundleId, destinationDeviceId, expiresAt",
    });
    this.version(2).stores({
      settings: "key",
      seen: "messageId, seenAt",
    });
    this.version(3).stores({
      ydocs: "objectId",
    });
  }
}
