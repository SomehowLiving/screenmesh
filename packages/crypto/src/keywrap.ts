import { fromBase64, toBase64 } from "@screenmesh/protocol";

/**
 * X25519 identity-key encode/decode helpers. Originally built for
 * workspace-key rotation (wrapping a new symmetric key per device on
 * revocation); that mechanism has been retired in favor of per-pair
 * Double Ratchet sessions (packages/crypto/src/ratchet.ts), which give a
 * strictly better guarantee — each pair's secrecy is independent, so
 * revoking one device doesn't require rekeying the rest of the group.
 * These export/import helpers are still used to move identity keys
 * across the wire (presence, pairing) and to seed ratchet bootstrap.
 * See docs/Security.md §5.
 */

export async function exportEncryptionPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(new Uint8Array(raw));
}

export async function importEncryptionPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(b64) as BufferSource, "X25519", true, []);
}

/** Raw bytes of the pairing secret — fed into ratchet session bootstrap. */
export async function exportRawWorkspaceKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}
