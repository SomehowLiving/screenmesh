/**
 * AES-GCM primitives with per-message nonces. `generateWorkspaceKey`'s
 * output now serves as the pairing secret that seeds every pairwise
 * Double Ratchet session (packages/crypto/src/ratchet.ts) — actual
 * message keys are ratchet-derived per docs/Security.md §5, not this key
 * directly.
 */

import { fromBase64, toBase64 } from "@screenmesh/protocol";

const AES_PARAMS = { name: "AES-GCM", length: 256 } as const;
export const NONCE_BYTES = 12;

export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_PARAMS, true, ["encrypt", "decrypt"]);
}

/** Raw base64 export — used to share the key over the pairing QR channel. */
export async function exportWorkspaceKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(new Uint8Array(raw));
}

export async function importWorkspaceKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(b64) as BufferSource, AES_PARAMS, true, [
    "encrypt",
    "decrypt",
  ]);
}

export interface EncryptedPayload {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<EncryptedPayload> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    plaintext as BufferSource,
  );
  return { nonce, ciphertext: new Uint8Array(ciphertext) };
}

export async function decrypt(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.nonce as BufferSource },
    key,
    payload.ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}
