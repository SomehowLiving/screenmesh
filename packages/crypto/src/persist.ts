import {
  exportEd25519PrivateKey,
  exportPublicKey,
  importEd25519PrivateKey,
  importPublicKey,
  type DeviceIdentity,
} from "./identity.js";
import {
  exportEncryptionPrivateKey,
  exportEncryptionPublicKey,
  importEncryptionPrivateKey,
  importEncryptionPublicKey,
} from "./keywrap.js";

/**
 * JSON-serializable form of a DeviceIdentity, for contexts with no
 * IndexedDB structured-clone to lean on (the desktop agent runs in plain
 * Node — see packages/agent). Only meaningful for identities generated
 * with `generateIdentity({ extractable: true })`; browsers should keep
 * using non-extractable keys and Dexie's native CryptoKey persistence.
 */
export interface SerializedIdentity {
  deviceId: string;
  publicKeyB64: string;
  privateKeyB64: string;
  encryptionPublicKeyB64: string;
  encryptionPrivateKeyB64: string;
}

export async function serializeIdentity(identity: DeviceIdentity): Promise<SerializedIdentity> {
  return {
    deviceId: identity.deviceId,
    publicKeyB64: await exportPublicKey(identity.publicKey),
    privateKeyB64: await exportEd25519PrivateKey(identity.privateKey),
    encryptionPublicKeyB64: await exportEncryptionPublicKey(identity.encryptionPublicKey),
    encryptionPrivateKeyB64: await exportEncryptionPrivateKey(identity.encryptionPrivateKey),
  };
}

export async function deserializeIdentity(s: SerializedIdentity): Promise<DeviceIdentity> {
  return {
    deviceId: s.deviceId,
    publicKey: await importPublicKey(s.publicKeyB64),
    privateKey: await importEd25519PrivateKey(s.privateKeyB64),
    encryptionPublicKey: await importEncryptionPublicKey(s.encryptionPublicKeyB64),
    encryptionPrivateKey: await importEncryptionPrivateKey(s.encryptionPrivateKeyB64),
  };
}
