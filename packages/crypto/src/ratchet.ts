import { fromBase64, toBase64 } from "@screenmesh/protocol";

/**
 * A simplified Double Ratchet (Signal-style) session between exactly two
 * devices, giving each envelope its own single-use encryption key —
 * genuine per-message forward secrecy, not just per-workspace-epoch.
 * See docs/Security.md §5 for the full design rationale.
 *
 * Bootstrap ("X3DH-lite"): the initial root key mixes each device's
 * long-term X25519 identity key (learned via the relay's HTTP join API —
 * NOT independently authenticated) with the pairing secret that traveled
 * over the out-of-band QR channel:
 *
 *   rootKey0 = HKDF(salt = pairingSecret, ikm = ECDH(myIdentity, theirIdentity), info = ...)
 *
 * A relay that substitutes identity keys in transit still can't derive
 * rootKey0 without the QR secret, so the QR remains the real trust
 * anchor. Both sides seed their ratchet keypair with their OWN identity
 * keypair (not a fresh ephemeral one) so EITHER side can send first
 * without having received anything — the first message(s) on a session,
 * before the peer has ever replied, therefore derive their key from
 * long-term identity material and don't have independent forward secrecy
 * from a future identity-key compromise. The moment the peer replies
 * (any message at all), both sides roll over to fresh ephemeral keys and
 * full forward secrecy applies from then on — the session "heals" after
 * one round trip. This is a deliberate, documented simplification, not
 * an oversight: a full X3DH needs a published one-time-prekey bundle,
 * which needs server infrastructure we don't have yet.
 *
 * Also deliberately out of scope: skipped-message-key tolerance is
 * capped rather than unbounded (see MAX_SKIPPED_KEYS/MAX_SKIP_PER_STEP).
 */

const HKDF_INFO_ROOT = "screenmesh-ratchet-root-v1";
const HKDF_INFO_DH = "screenmesh-ratchet-dh-v1";
const MAX_SKIPPED_KEYS = 50;
const MAX_SKIP_PER_STEP = 500;

export interface RatchetKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

interface SkippedKey {
  ratchetPublicKeyB64: string;
  messageNumber: number;
  messageKeyB64: string;
}

export interface RatchetSession {
  rootKey: Uint8Array;
  /** My current DH ratchet keypair — starts as my identity keypair, then
   *  becomes fresh ephemeral material the first time I have to respond
   *  to the peer's ratchet key changing. */
  myRatchetKeyPair: RatchetKeyPair;
  /** The peer's most recently observed ratchet public key. */
  theirRatchetPublicKeyB64: string;
  sendChainKey: Uint8Array | null;
  recvChainKey: Uint8Array | null;
  sendMessageNumber: number;
  recvMessageNumber: number;
  previousSendChainLength: number;
  skippedKeys: SkippedKey[];
}

export interface RatchetMessageHeader {
  ratchetPublicKeyB64: string;
  messageNumber: number;
  previousChainLength: number;
}

export class RatchetError extends Error {}

// --- primitives ---

async function ecdhBits(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  bitLength = 256,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: theirPublic },
    myPrivate,
    bitLength,
  );
  return new Uint8Array(bits);
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info),
    },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

/** One step of the symmetric-key ratchet: derive a message key, advance the chain. */
async function stepChain(
  chainKey: Uint8Array,
): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const [messageKey, nextChainKey] = await Promise.all([
    hmacSha256(chainKey, new Uint8Array([0x01])),
    hmacSha256(chainKey, new Uint8Array([0x02])),
  ]);
  return { messageKey, nextChainKey };
}

async function importAesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function generateRatchetKeyPair(): Promise<RatchetKeyPair> {
  const pair = (await crypto.subtle.generateKey("X25519", false, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

async function exportRatchetPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

async function importRatchetPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(b64) as BufferSource, "X25519", true, []);
}

/**
 * Bootstrap a brand-new session with a peer. Both sides compute this with
 * the same sorted inputs and arrive at the same root key. Each side's
 * `myRatchetKeyPair` starts as ITS OWN identity keypair (not a fresh
 * ephemeral one) specifically so either side can send first without
 * having received anything yet — see the module doc comment for the
 * forward-secrecy trade-off this implies until the first round trip.
 */
export async function initRatchetSession(params: {
  workspaceId: string;
  myDeviceId: string;
  myIdentityPublic: CryptoKey;
  myIdentityPrivate: CryptoKey;
  peerDeviceId: string;
  peerIdentityPublic: CryptoKey;
  pairingSecret: Uint8Array;
}): Promise<RatchetSession> {
  const ecdh = await ecdhBits(params.myIdentityPrivate, params.peerIdentityPublic);
  const [a, b] = [params.myDeviceId, params.peerDeviceId].sort();
  const info = `${HKDF_INFO_ROOT}|${params.workspaceId}|${a}|${b}`;
  const rootKey = await hkdf(ecdh, params.pairingSecret, info, 32);
  return {
    rootKey,
    myRatchetKeyPair: { publicKey: params.myIdentityPublic, privateKey: params.myIdentityPrivate },
    theirRatchetPublicKeyB64: await exportRatchetPublicKey(params.peerIdentityPublic),
    sendChainKey: null,
    recvChainKey: null,
    sendMessageNumber: 0,
    recvMessageNumber: 0,
    previousSendChainLength: 0,
    skippedKeys: [],
  };
}

/** Advance the DH ratchet: mix a fresh DH result into the root key, derive a new chain key. */
async function dhRatchetStep(
  rootKey: Uint8Array,
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  const dh = await ecdhBits(myPrivate, theirPublic);
  const out = await hkdf(dh, rootKey, HKDF_INFO_DH, 64);
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

function pushSkipped(session: RatchetSession, entry: SkippedKey): void {
  session.skippedKeys.push(entry);
  while (session.skippedKeys.length > MAX_SKIPPED_KEYS) session.skippedKeys.shift();
}

function takeSkipped(
  session: RatchetSession,
  ratchetPublicKeyB64: string,
  messageNumber: number,
): Uint8Array | null {
  const idx = session.skippedKeys.findIndex(
    (k) => k.ratchetPublicKeyB64 === ratchetPublicKeyB64 && k.messageNumber === messageNumber,
  );
  if (idx === -1) return null;
  const found = session.skippedKeys[idx];
  session.skippedKeys.splice(idx, 1);
  return fromBase64(found!.messageKeyB64);
}

/** Advance recvChainKey forward to `upTo`, caching each derived key as skipped (not returned). */
async function skipForward(
  session: RatchetSession,
  ratchetPublicKeyB64: string,
  upTo: number,
): Promise<void> {
  if (!session.recvChainKey) return;
  const count = upTo - session.recvMessageNumber;
  if (count <= 0) return;
  if (count > MAX_SKIP_PER_STEP) {
    throw new RatchetError(`refusing to derive ${count} skipped keys in one step`);
  }
  for (let i = 0; i < count; i++) {
    const { messageKey, nextChainKey } = await stepChain(session.recvChainKey);
    pushSkipped(session, {
      ratchetPublicKeyB64,
      messageNumber: session.recvMessageNumber + i,
      messageKeyB64: toBase64(messageKey),
    });
    session.recvChainKey = nextChainKey;
  }
  session.recvMessageNumber = upTo;
}

/**
 * Sender side: derive the next message key, mutating the session (the
 * chain advances one-way; the returned key is meant to be used once).
 * Callers MUST persist the mutated session after this returns.
 */
export async function ratchetEncrypt(
  session: RatchetSession,
): Promise<{ messageKey: CryptoKey; header: RatchetMessageHeader }> {
  if (!session.sendChainKey) {
    const theirPublic = await importRatchetPublicKey(session.theirRatchetPublicKeyB64);
    const stepped = await dhRatchetStep(
      session.rootKey,
      session.myRatchetKeyPair.privateKey,
      theirPublic,
    );
    session.rootKey = stepped.rootKey;
    session.sendChainKey = stepped.chainKey;
    session.previousSendChainLength = session.sendMessageNumber;
    session.sendMessageNumber = 0;
  }
  const { messageKey, nextChainKey } = await stepChain(session.sendChainKey);
  const header: RatchetMessageHeader = {
    ratchetPublicKeyB64: await exportRatchetPublicKey(session.myRatchetKeyPair.publicKey),
    messageNumber: session.sendMessageNumber,
    previousChainLength: session.previousSendChainLength,
  };
  session.sendChainKey = nextChainKey;
  session.sendMessageNumber += 1;
  return { messageKey: await importAesKey(messageKey), header };
}

/**
 * Receiver side: derive the message key matching this header, mutating
 * the session (performing a DH ratchet step if the peer's key changed —
 * or if we've never received anything yet — and caching any skipped-over
 * keys for later out-of-order arrivals). Callers MUST persist the
 * mutated session after this returns.
 */
export async function ratchetDecrypt(
  session: RatchetSession,
  header: RatchetMessageHeader,
): Promise<CryptoKey> {
  const cached = takeSkipped(session, header.ratchetPublicKeyB64, header.messageNumber);
  if (cached) return importAesKey(cached);

  if (header.ratchetPublicKeyB64 !== session.theirRatchetPublicKeyB64 || !session.recvChainKey) {
    if (session.recvChainKey) {
      // Drain whatever's left of the OLD receiving chain (bounded by the
      // sender's declared previous-chain length) so late arrivals on it
      // can still be found in the skipped-key cache.
      await skipForward(session, session.theirRatchetPublicKeyB64, header.previousChainLength);
    }
    const theirNewPublic = await importRatchetPublicKey(header.ratchetPublicKeyB64);
    const stepped = await dhRatchetStep(
      session.rootKey,
      session.myRatchetKeyPair.privateKey,
      theirNewPublic,
    );
    session.rootKey = stepped.rootKey;
    session.recvChainKey = stepped.chainKey;
    session.recvMessageNumber = 0;
    session.theirRatchetPublicKeyB64 = header.ratchetPublicKeyB64;
    // Force a fresh sending step next time we send, with fresh ephemeral
    // material — this is what "heals" the session after a round trip.
    session.sendChainKey = null;
    session.myRatchetKeyPair = await generateRatchetKeyPair();
  }

  if (!session.recvChainKey) {
    throw new RatchetError("no receiving chain established for this header");
  }
  if (header.messageNumber < session.recvMessageNumber) {
    throw new RatchetError(
      `message ${header.messageNumber} on the current chain was already consumed and is not in the skipped-key cache`,
    );
  }
  if (header.messageNumber > session.recvMessageNumber) {
    await skipForward(session, header.ratchetPublicKeyB64, header.messageNumber);
  }
  const { messageKey, nextChainKey } = await stepChain(session.recvChainKey);
  session.recvChainKey = nextChainKey;
  session.recvMessageNumber = header.messageNumber + 1;
  return importAesKey(messageKey);
}
