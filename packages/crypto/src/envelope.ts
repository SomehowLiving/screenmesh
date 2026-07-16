import {
  ENVELOPE_VERSION,
  toBase64,
  type SecureEnvelope,
} from "@screenmesh/protocol";
import { decrypt, encrypt, NONCE_BYTES } from "./encrypt.js";
import { sign, verify, type DeviceIdentity } from "./identity.js";
import type { RatchetMessageHeader } from "./ratchet.js";

/**
 * Seal/open SecureEnvelopes: AES-GCM encrypt with a per-message ratchet
 * key (nonce prepended to the ciphertext), then Ed25519-sign the
 * canonical envelope bytes — including the ratchet header, so a MITM
 * can't swap in a different ratchet position without invalidating the
 * signature. See docs/Security.md §3 and §5.
 *
 * verifyEnvelope and decryptEnvelope are deliberately SEPARATE calls
 * (not one "openEnvelope"): the ratchet header must never be trusted
 * enough to advance session state before the signature is checked — a
 * forged envelope with a manipulated ratchetPublicKeyB64/messageNumber
 * could otherwise corrupt the session before its authenticity is known.
 * Callers must always verify, THEN derive the ratchet message key from
 * the (now-trusted) header, THEN decrypt.
 */

function canonicalBytes(env: Omit<SecureEnvelope, "signature">): Uint8Array {
  const head = [
    env.version,
    env.messageId,
    env.senderDeviceId,
    env.recipientDeviceId,
    env.workspaceId,
    env.createdAt,
    env.expiresAt ?? "",
    env.sequenceNumber,
    env.ratchetPublicKeyB64,
    env.messageNumber,
    env.previousChainLength,
  ].join("|");
  return new TextEncoder().encode(`${head}|${toBase64(env.ciphertext)}`);
}

export interface SealParams {
  identity: DeviceIdentity;
  recipientDeviceId: string;
  workspaceId: string;
  /** Per-message AES-GCM key derived from the sender's ratchet session. */
  messageKey: CryptoKey;
  ratchetHeader: RatchetMessageHeader;
  plaintext: Uint8Array;
  sequenceNumber: number;
  createdAt: number;
  expiresAt?: number;
}

export async function sealEnvelope(params: SealParams): Promise<SecureEnvelope> {
  const { nonce, ciphertext } = await encrypt(params.messageKey, params.plaintext);
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);

  const unsigned: Omit<SecureEnvelope, "signature"> = {
    version: ENVELOPE_VERSION,
    messageId: crypto.randomUUID(),
    senderDeviceId: params.identity.deviceId,
    recipientDeviceId: params.recipientDeviceId,
    workspaceId: params.workspaceId,
    createdAt: params.createdAt,
    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
    sequenceNumber: params.sequenceNumber,
    ratchetPublicKeyB64: params.ratchetHeader.ratchetPublicKeyB64,
    messageNumber: params.ratchetHeader.messageNumber,
    previousChainLength: params.ratchetHeader.previousChainLength,
    ciphertext: combined,
  };
  const signature = await sign(params.identity, canonicalBytes(unsigned));
  return { ...unsigned, signature };
}

/**
 * Step 1: check expiry and authenticity. MUST be called — and must
 * succeed — before the envelope's ratchet header is used for anything,
 * including deriving a message key (which mutates ratchet session state).
 */
export async function verifyEnvelope(
  env: SecureEnvelope,
  senderPublicKey: CryptoKey,
  now: number,
): Promise<void> {
  if (env.expiresAt !== undefined && now >= env.expiresAt) {
    throw new Error(`envelope ${env.messageId} expired`);
  }
  const { signature, ...unsigned } = env;
  const ok = await verify(senderPublicKey, signature, canonicalBytes(unsigned));
  if (!ok) {
    throw new Error(`invalid signature on envelope ${env.messageId}`);
  }
}

/**
 * Step 2: decrypt. Only call after verifyEnvelope has succeeded AND the
 * ratchet session has derived `messageKey` from this envelope's
 * (now-trusted) header.
 */
export async function decryptEnvelope(
  env: SecureEnvelope,
  messageKey: CryptoKey,
): Promise<Uint8Array> {
  return decrypt(messageKey, {
    nonce: env.ciphertext.slice(0, NONCE_BYTES),
    ciphertext: env.ciphertext.slice(NONCE_BYTES),
  });
}
