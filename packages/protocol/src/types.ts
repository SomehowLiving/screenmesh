/** Canonical ScreenMesh data model. See docs/Architecture.md §3. */

export type DeviceType = "phone" | "laptop" | "tablet" | "display" | "desktop";
export type DeviceRole = "input" | "editor" | "display" | "relay";

/**
 * Capability routing (docs/Roadmap.md Phase 5): a device advertises what
 * it can do, and a send can target "whichever device has this" instead of
 * a specific device — e.g. "route this command to the terminal." Not a
 * closed enum: devices may advertise anything, but these are the ones the
 * UI has first-class pickers for.
 */
export type DeviceCapability =
  | "terminal"
  | "filesystem"
  | "camera"
  | "microphone"
  | "gps"
  | "browser"
  | "local-models";

export interface Device {
  id: string;
  name: string;
  /** Base64-encoded Ed25519 public key, exchanged at pairing. */
  publicKey: string;
  /** Base64 X25519 public key for key-agreement. */
  encryptionKey?: string;
  type: DeviceType;
  role: DeviceRole;
  /** Capabilities this device advertises to the rest of the workspace. */
  capabilities?: string[];
  lastSeenAt: number;
  status: "online" | "offline";
  trusted: boolean;
}

/** The subset of Device exchanged during pairing and presence. */
export interface DeviceInfo {
  id: string;
  name: string;
  /** Base64 Ed25519 signing public key. */
  publicKey: string;
  /** Base64 X25519 public key for key-agreement (workspace key rotation). */
  encryptionKey?: string;
  type: DeviceType;
  capabilities?: string[];
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
  /** Delivered but awaiting the recipient's explicit accept (requireConfirmation). */
  | "pending"
  | "opened"
  /** Recipient explicitly declined a requireConfirmation delivery. */
  | "rejected"
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
  /** The SendOptions this delivery was created with, kept for enforcement
   *  (deleteAfterOpening, requireConfirmation) and UI display. */
  options?: SendOptions;
}

/** Content shape for "text" | "link" | "code" objects. */
export interface TextContent {
  text: string;
}

/** Content shape for "image" | "file" objects (small payloads, base64). */
export interface FileContent {
  name: string;
  mimeType: string;
  size: number;
  dataB64: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** Content shape for "checklist" objects. */
export interface ChecklistContent {
  items: ChecklistItem[];
}

/** Options attached to a send action ("expire after 1 hour", etc.). */
export interface SendOptions {
  deliverWhenDeviceReturns?: boolean;
  expiresAt?: number;
  deleteAfterOpening?: boolean;
  requireConfirmation?: boolean;
}
