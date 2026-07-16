import { fromBase64, toBase64 } from "./base64.js";

/**
 * Every message on every transport is wrapped in a SecureEnvelope.
 * Encryption happens before the envelope reaches any transport; relays
 * and carrier devices only ever see ciphertext. See docs/Security.md §3.
 *
 * The payload key comes from a per-pair Double Ratchet session, not a
 * shared workspace secret (see docs/Security.md §5 and
 * packages/crypto/src/ratchet.ts) — `ratchetPublicKeyB64` /
 * `messageNumber` / `previousChainLength` are exactly what the recipient
 * needs to derive the matching message key.
 */
export interface SecureEnvelope {
  version: number;
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  workspaceId: string;
  createdAt: number;
  expiresAt?: number;
  /** Monotonic per-sender counter; secondary to messageId dedup for replay protection. */
  sequenceNumber: number;
  /** Sender's current ratchet public key (base64 X25519). */
  ratchetPublicKeyB64: string;
  /** Position in the sending chain identified by ratchetPublicKeyB64. */
  messageNumber: number;
  /** Length of the sender's previous sending chain (lets the receiver drain it on a ratchet step). */
  previousChainLength: number;
  /** AES-GCM nonce (12 bytes) prepended to the ciphertext. */
  ciphertext: Uint8Array;
  /** Ed25519 signature over the envelope fields + ciphertext. */
  signature: Uint8Array;
}

export const ENVELOPE_VERSION = 2;

/** JSON wire form of a SecureEnvelope (binary fields as base64). */
export interface EnvelopeJson {
  version: number;
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  workspaceId: string;
  createdAt: number;
  expiresAt?: number;
  sequenceNumber: number;
  ratchetPublicKeyB64: string;
  messageNumber: number;
  previousChainLength: number;
  ciphertext: string;
  signature: string;
}

export function envelopeToJson(env: SecureEnvelope): EnvelopeJson {
  return {
    version: env.version,
    messageId: env.messageId,
    senderDeviceId: env.senderDeviceId,
    recipientDeviceId: env.recipientDeviceId,
    workspaceId: env.workspaceId,
    createdAt: env.createdAt,
    ...(env.expiresAt !== undefined ? { expiresAt: env.expiresAt } : {}),
    sequenceNumber: env.sequenceNumber,
    ratchetPublicKeyB64: env.ratchetPublicKeyB64,
    messageNumber: env.messageNumber,
    previousChainLength: env.previousChainLength,
    ciphertext: toBase64(env.ciphertext),
    signature: toBase64(env.signature),
  };
}

export function envelopeFromJson(json: EnvelopeJson): SecureEnvelope {
  return {
    version: json.version,
    messageId: json.messageId,
    senderDeviceId: json.senderDeviceId,
    recipientDeviceId: json.recipientDeviceId,
    workspaceId: json.workspaceId,
    createdAt: json.createdAt,
    ...(json.expiresAt !== undefined ? { expiresAt: json.expiresAt } : {}),
    sequenceNumber: json.sequenceNumber,
    ratchetPublicKeyB64: json.ratchetPublicKeyB64,
    messageNumber: json.messageNumber,
    previousChainLength: json.previousChainLength,
    ciphertext: fromBase64(json.ciphertext),
    signature: fromBase64(json.signature),
  };
}

/**
 * Payload encoded into a pairing QR code / join link — the explicit trust
 * ceremony. The QR-transported secret now serves as the ratchet
 * bootstrap secret for every pairwise session in the workspace (see
 * packages/crypto/src/ratchet.ts), not as a direct message-encryption
 * key — a relay that substitutes identity keys in transit still can't
 * derive a session's root key without it.
 *
 * Kept deliberately minimal so the QR stays low-density and easy to scan:
 * workspace name, roster, and owner identity all come from the join
 * response instead. See docs/Security.md §2.
 */
export interface PairingPayload {
  workspaceId: string;
  /** Base64 raw secret, shared over the visual channel, seeding every
   *  pairwise ratchet session in this workspace. */
  workspaceKey: string;
  /** Single-use, short-lived token authorizing this pairing. */
  pairingToken: string;
  expiresAt: number;
  /**
   * http(s) base URL of the relay server. Runtime hint only — NOT encoded
   * into the QR; joiners default to their own origin (same-origin proxy).
   */
  serverUrl?: string;
}
