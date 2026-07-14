import { fromBase64, toBase64 } from "@screenmesh/protocol";
import { decrypt, encrypt } from "./encrypt.js";

/**
 * Wrapping workspace keys for rotation (docs/Security.md §5): the owner
 * derives a pairwise AES key via X25519 ECDH with each remaining device
 * and encrypts the new workspace key under it. A revoked device holds the
 * OLD workspace keys but cannot derive anyone else's pairwise secret, so
 * rotated keys — and all traffic after rotation — stay out of its reach.
 *
 * TODO(hardening): run the shared secret through HKDF with a context
 * label instead of using it directly as the AES key.
 */

export async function exportEncryptionPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(new Uint8Array(raw));
}

export async function importEncryptionPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(b64) as BufferSource, "X25519", true, []);
}

async function pairwiseAesKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPublic },
    myPrivate,
    256,
  );
  return crypto.subtle.importKey("raw", sharedBits, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export interface WrappedKey {
  nonceB64: string;
  wrappedKeyB64: string;
}

export async function wrapKeyBytes(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  keyBytes: Uint8Array,
): Promise<WrappedKey> {
  const aes = await pairwiseAesKey(myPrivate, theirPublic);
  const { nonce, ciphertext } = await encrypt(aes, keyBytes);
  return { nonceB64: toBase64(nonce), wrappedKeyB64: toBase64(ciphertext) };
}

export async function unwrapKeyBytes(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  wrapped: WrappedKey,
): Promise<Uint8Array> {
  const aes = await pairwiseAesKey(myPrivate, theirPublic);
  return decrypt(aes, {
    nonce: fromBase64(wrapped.nonceB64),
    ciphertext: fromBase64(wrapped.wrappedKeyB64),
  });
}

export async function importRawWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportRawWorkspaceKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}
