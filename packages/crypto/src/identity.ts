/**
 * Device identity: an Ed25519 keypair generated on first launch.
 * The private key never leaves the device. See docs/Security.md §1.
 *
 * Browser support for Ed25519 in Web Crypto varies; if it proves
 * unreliable, swap the internals for libsodium.js — callers only
 * see this module's interface.
 */

import { fromBase64, toBase64 } from "@screenmesh/protocol";

export interface DeviceIdentity {
  deviceId: string;
  /** Ed25519 — signing. */
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** X25519 — key agreement (workspace key rotation). */
  encryptionPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
}

export async function generateIdentity(): Promise<DeviceIdentity> {
  const signing = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const agreement = (await crypto.subtle.generateKey("X25519", false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    deviceId: crypto.randomUUID(),
    publicKey: signing.publicKey,
    privateKey: signing.privateKey,
    encryptionPublicKey: agreement.publicKey,
    encryptionPrivateKey: agreement.privateKey,
  };
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(new Uint8Array(raw));
}

export async function importPublicKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(base64) as BufferSource, "Ed25519", true, [
    "verify",
  ]);
}

export async function sign(
  identity: DeviceIdentity,
  data: Uint8Array,
): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("Ed25519", identity.privateKey, data as BufferSource);
  return new Uint8Array(sig);
}

export async function verify(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify("Ed25519", publicKey, signature as BufferSource, data as BufferSource);
}
