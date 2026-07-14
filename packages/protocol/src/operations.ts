/**
 * ScreenMesh syncs by exchanging operations, not whole workspaces.
 * Devices exchange only the operations they are missing.
 * See docs/Architecture.md §2 (Layer 3).
 */

export type OperationType =
  | "CREATE_OBJECT"
  | "UPDATE_OBJECT"
  | "DELETE_OBJECT"
  | "SEND_TO_DEVICE"
  | "MARK_DELIVERED"
  | "MARK_OPENED"
  | "PIN_OBJECT"
  | "MOVE_OBJECT"
  | "ADD_ATTACHMENT"
  | "REVOKE_DEVICE"
  | "ROTATE_KEY"
  | "YJS_UPDATE"
  | "CONTINUE_ON_DEVICE";

export interface Operation<TPayload = unknown> {
  operationId: string;
  deviceId: string;
  workspaceId: string;
  type: OperationType;
  objectId?: string;
  timestamp: number;
  payload: TPayload;
}

/** A device's view of how far it has seen each peer's oplog. */
export type SyncVector = Record<string, number>;

import type { MeshObject, SendOptions } from "./types.js";

export interface CreateObjectPayload {
  object: MeshObject;
}

export interface SendToDevicePayload {
  objectId: string;
  options?: SendOptions;
}

export interface ObjectRefPayload {
  objectId: string;
}

export interface RevokeDevicePayload {
  deviceId: string;
}

/**
 * A new workspace key, wrapped per-recipient via X25519 ECDH so a revoked
 * device (which still holds old keys) cannot read it.
 */
export interface RotateKeyPayload {
  epoch: number;
  wrappedKeyB64: string;
  nonceB64: string;
}

/** A Yjs document update for collaborative editing of an object. */
export interface YjsUpdatePayload {
  objectId: string;
  updateB64: string;
}

/** Last-write-wins content replacement (checklist toggles, etc.). */
export interface UpdateObjectPayload {
  objectId: string;
  content: unknown;
  updatedAt: number;
}

/** Ask the target device to open this object for editing. */
export interface ContinueOnDevicePayload {
  objectId: string;
}
