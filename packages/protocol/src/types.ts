/** Canonical ScreenMesh data model. See docs/Architecture.md §3. */

export type DeviceType = "phone" | "laptop" | "tablet" | "display" | "desktop";
export type DeviceRole = "input" | "editor" | "display" | "relay";

export interface Device {
  id: string;
  name: string;
  /** Base64-encoded Ed25519 public key, exchanged at pairing. */
  publicKey: string;
  type: DeviceType;
  role: DeviceRole;
  lastSeenAt: number;
  status: "online" | "offline";
  trusted: boolean;
}

/** The subset of Device exchanged during pairing and presence. */
export interface DeviceInfo {
  id: string;
  name: string;
  publicKey: string;
  type: DeviceType;
}

export type WorkspaceMode = "personal" | "temporary" | "shared";

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  expiresAt?: number;
  ownerDeviceId: string;
  memberDeviceIds: string[];
  mode: WorkspaceMode;
}

export type MeshObjectType =
  | "text"
  | "link"
  | "code"
  | "image"
  | "file"
  | "checklist"
  | "clipboard"
  | "command";

export interface MeshObject {
  id: string;
  workspaceId: string;
  type: MeshObjectType;
  content: unknown;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export type DeliveryStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "opened"
  | "expired"
  | "failed";

export interface Delivery {
  id: string;
  objectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  status: DeliveryStatus;
  createdAt: number;
  deliveredAt?: number;
  openedAt?: number;
}

/** Options attached to a send action ("expire after 1 hour", etc.). */
export interface SendOptions {
  deliverWhenDeviceReturns?: boolean;
  expiresAt?: number;
  deleteAfterOpening?: boolean;
  requireConfirmation?: boolean;
}
