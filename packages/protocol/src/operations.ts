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
  | "FILE_CHUNK";

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
export interface FileChunkPayload {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  dataB64: string;
  meta?: {
    objectType: "file" | "image";
    name: string;
    mimeType: string;
    size: number;
    createdBy: string;
    createdAt: number;
    expiresAt?: number;
    options?: SendOptions;
  };
}
