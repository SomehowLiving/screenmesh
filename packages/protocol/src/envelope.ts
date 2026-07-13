import { fromBase64, toBase64 } from "./base64.js";

/**
 * Every message on every transport is wrapped in a SecureEnvelope.
 * Encryption happens before the envelope reaches any transport; relays
 * and carrier devices only ever see ciphertext. See docs/Security.md §3.
 */
export interface SecureEnvelope {
  version: number;
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  workspaceId: string;
  createdAt: number;
  expiresAt?: number;
  /** Monotonic per-sender counter for replay protection. */
  sequenceNumber: number;
  /** AES-GCM nonce (12 bytes) prepended to the ciphertext. */
  ciphertext: Uint8Array;
  /** Ed25519 signature over the envelope fields + ciphertext. */
  signature: Uint8Array;
}

export const ENVELOPE_VERSION = 1;

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
    ciphertext: fromBase64(json.ciphertext),
    signature: fromBase64(json.signature),
  };
}

/**
 * Payload encoded into a pairing QR code / join link — the explicit trust
 * ceremony. The workspace key travels over this trusted visual channel
 * (MVP bootstrap), so relays never hold key material.
 *
 * Kept deliberately minimal so the QR stays low-density and easy to scan:
 * workspace name, roster, and owner identity all come from the join
 * response instead. See docs/Security.md §2.
 */
export interface PairingPayload {
  workspaceId: string;
  /** Base64 raw AES-256 workspace key, shared over the visual channel. */
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
