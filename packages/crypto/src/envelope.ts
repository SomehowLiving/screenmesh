import {
  ENVELOPE_VERSION,
  toBase64,
  type SecureEnvelope,
} from "@screenmesh/protocol";
import { decrypt, encrypt, NONCE_BYTES } from "./encrypt.js";
import { sign, verify, type DeviceIdentity } from "./identity.js";

/**
 * Seal/open SecureEnvelopes: AES-GCM encrypt with the workspace key
 * (nonce prepended to the ciphertext), then Ed25519-sign the canonical
 * envelope bytes. Verification order on open: expiry → signature →
 * decrypt. See docs/Security.md §3.
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
    env.keyEpoch,
  ].join("|");
  return new TextEncoder().encode(`${head}|${toBase64(env.ciphertext)}`);
}

export interface SealParams {
  identity: DeviceIdentity;
  recipientDeviceId: string;
  workspaceId: string;
  workspaceKey: CryptoKey;
  plaintext: Uint8Array;
  sequenceNumber: number;
  createdAt: number;
  expiresAt?: number;
  /** Workspace-key generation used for encryption (default 0). */
  keyEpoch?: number;
}

export async function sealEnvelope(params: SealParams): Promise<SecureEnvelope> {
  const { nonce, ciphertext } = await encrypt(params.workspaceKey, params.plaintext);
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
    keyEpoch: params.keyEpoch ?? 0,
    ciphertext: combined,
  };
  const signature = await sign(params.identity, canonicalBytes(unsigned));
  return { ...unsigned, signature };
}

/** Verifies and decrypts an envelope; throws on expiry or bad signature. */
export async function openEnvelope(
  env: SecureEnvelope,
  senderPublicKey: CryptoKey,
  workspaceKey: CryptoKey,
  now: number,
): Promise<Uint8Array> {
  if (env.expiresAt !== undefined && now >= env.expiresAt) {
    throw new Error(`envelope ${env.messageId} expired`);
  }
  const { signature, ...unsigned } = env;
  const ok = await verify(senderPublicKey, signature, canonicalBytes(unsigned));
  if (!ok) {
    throw new Error(`invalid signature on envelope ${env.messageId}`);
  }
  return decrypt(workspaceKey, {
    nonce: env.ciphertext.slice(0, NONCE_BYTES),
    ciphertext: env.ciphertext.slice(NONCE_BYTES),
  });
}
