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
  | "YJS_UPDATE"
  | "CONTINUE_ON_DEVICE"
  | "CARRY_BUNDLE"
  | "REJECT_OBJECT"
  | "FILE_CHUNK"
  | "FILE_CHUNK_ACK"
  | "EDIT_PRESENCE";

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

import type { MeshObject, MeshObjectType, SendOptions } from "./types.js";

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
  /** Present when a reclassification changes the object's type (e.g. a
   *  misdetected checklist corrected to a document) alongside its content. */
  type?: MeshObjectType;
}

/** Ask the target device to open this object for editing. */
export interface ContinueOnDevicePayload {
  objectId: string;
}

/**
 * Store–carry–forward (docs/Architecture.md §2): hand an opaque, already
 * end-to-end-encrypted envelope to a peer for safekeeping, addressed to a
 * third device the sender can't currently reach. Since envelope payloads
 * are now encrypted with a per-pair ratchet key (see
 * packages/crypto/src/ratchet.ts), the carrier genuinely cannot decrypt
 * the inner envelope — it doesn't hold the ratchet session between the
 * original sender and the true destination, unlike the relay/carrier
 * under the old shared-workspace-key model. `encryptedPayloadB64` is the
 * base64 JSON of an EnvelopeJson.
 */
export interface CarryBundlePayload {
  bundleId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  encryptedPayloadB64: string;
  createdAt: number;
  expiresAt: number;
  /** Remaining number of DISTINCT carriers this bundle may still be handed to. */
  hopLimit: number;
}

/**
 * Secure file drop (docs/Roadmap.md Phase 5): larger files are split into
 * chunks, each sent as its own encrypted envelope (own ratchet message,
 * own carry-eligibility) rather than one giant envelope. The receiver
 * materializes the MeshObject only once every chunk has arrived; `meta`
 * carries everything needed to do that and is only sent on chunk 0 to
 * avoid repeating it in every chunk.
 */
export interface FileChunkMeta {
  objectType: "file" | "image";
  name: string;
  mimeType: string;
  size: number;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  options?: SendOptions;
}

export interface FileChunkPayload {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  dataB64: string;
  meta?: FileChunkMeta;
}

/**
 * Sent by the receiver immediately after it durably persists a chunk (see
 * ScreenMeshDb's `fileChunks` table), so the sender can tell which chunks
 * actually landed and resend only the ones that didn't — instead of either
 * trusting a fire-and-forget send or resending the whole file blind.
 */
export interface FileChunkAckPayload {
  fileId: string;
  chunkIndex: number;
}

/**
 * Ephemeral "someone is editing this" signal — a UX safeguard, not part of
 * the durable object model. Sent as a heartbeat while a device has an
 * editable object's editor open, and once more with `active: false` on
 * close. Never blocks another device from also editing; it exists only so
 * a person can see they might be about to collide with someone else,
 * since the underlying Yjs merge can't fully protect a peer's first edit
 * on an object it never got seeded Yjs state for (see engine.ts's
 * editText doc comment).
 */
export interface EditPresencePayload {
  objectId: string;
  active: boolean;
}
