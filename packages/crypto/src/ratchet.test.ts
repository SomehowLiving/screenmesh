import { beforeEach, describe, expect, it } from "vitest";
import { generateIdentity, type DeviceIdentity } from "./identity.js";
import {
  initRatchetSession,
  ratchetDecrypt,
  ratchetEncrypt,
  RatchetError,
  type RatchetMessageHeader,
  type RatchetSession,
} from "./ratchet.js";

const WORKSPACE_ID = "workspace-1";
const TEST_NONCE = new Uint8Array(12); // fixed nonce: fine for single-use test keys, never reused per key here.

async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: TEST_NONCE },
    key,
    new TextEncoder().encode(plaintext),
  );
  return new Uint8Array(ct);
}

async function aesDecrypt(key: CryptoKey, ciphertext: Uint8Array): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: TEST_NONCE },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

interface SessionPair {
  alice: DeviceIdentity;
  bob: DeviceIdentity;
  aliceSession: RatchetSession;
  bobSession: RatchetSession;
}

async function bootstrapSessionPair(): Promise<SessionPair> {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const pairingSecret = crypto.getRandomValues(new Uint8Array(32));

  const aliceSession = await initRatchetSession({
    workspaceId: WORKSPACE_ID,
    myDeviceId: alice.deviceId,
    myIdentityPublic: alice.encryptionPublicKey,
    myIdentityPrivate: alice.encryptionPrivateKey,
    peerDeviceId: bob.deviceId,
    peerIdentityPublic: bob.encryptionPublicKey,
    pairingSecret,
  });
  const bobSession = await initRatchetSession({
    workspaceId: WORKSPACE_ID,
    myDeviceId: bob.deviceId,
    myIdentityPublic: bob.encryptionPublicKey,
    myIdentityPrivate: bob.encryptionPrivateKey,
    peerDeviceId: alice.deviceId,
    peerIdentityPublic: alice.encryptionPublicKey,
    pairingSecret,
  });

  return { alice, bob, aliceSession, bobSession };
}

/** Simulates one message crossing the wire: only the header travels (plus ciphertext, out of scope here). */
async function sendAndDeliver(
  senderSession: RatchetSession,
  receiverSession: RatchetSession,
  plaintext: string,
): Promise<{ header: RatchetMessageHeader; decrypted: string }> {
  const { messageKey, header } = await ratchetEncrypt(senderSession);
  const ciphertext = await aesEncrypt(messageKey, plaintext);
  const recvKey = await ratchetDecrypt(receiverSession, header);
  const decrypted = await aesDecrypt(recvKey, ciphertext);
  return { header, decrypted };
}

describe("Double Ratchet session", () => {
  let pair: SessionPair;

  beforeEach(async () => {
    pair = await bootstrapSessionPair();
  });

  it("both sides derive the same root key at bootstrap", () => {
    // Both compute HKDF(salt=pairingSecret, ikm=ECDH(...), info=...|sorted(deviceIds))
    // from symmetric inputs — a bug in the sort/info-string would desync this silently.
    expect(pair.aliceSession.rootKey).toEqual(pair.bobSession.rootKey);
  });

  it("delivers Alice's first message to Bob correctly (identity-keyed, pre-heal)", async () => {
    const { decrypted } = await sendAndDeliver(pair.aliceSession, pair.bobSession, "hello bob");
    expect(decrypted).toBe("hello bob");
  });

  it("heals after one round trip: both directions work once each side has sent", async () => {
    const exportRaw = async (key: CryptoKey) =>
      new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const aliceIdentityRatchetPubBefore = await exportRaw(pair.aliceSession.myRatchetKeyPair.publicKey);
    const bobIdentityRatchetPubBefore = await exportRaw(pair.bobSession.myRatchetKeyPair.publicKey);

    await sendAndDeliver(pair.aliceSession, pair.bobSession, "hi from alice");
    const reply = await sendAndDeliver(pair.bobSession, pair.aliceSession, "hi from bob");
    expect(reply.decrypted).toBe("hi from bob");

    // Post-heal: both myRatchetKeyPairs should have rolled to fresh ephemeral
    // material, no longer the original long-term identity keys — this is
    // exactly the forward-secrecy property the module doc comment promises
    // "after one round trip."
    const aliceRatchetPubAfter = await exportRaw(pair.aliceSession.myRatchetKeyPair.publicKey);
    const bobRatchetPubAfter = await exportRaw(pair.bobSession.myRatchetKeyPair.publicKey);
    expect(aliceRatchetPubAfter).not.toEqual(aliceIdentityRatchetPubBefore);
    expect(bobRatchetPubAfter).not.toEqual(bobIdentityRatchetPubBefore);

    // Further exchanges keep working in both directions after healing.
    const again = await sendAndDeliver(pair.aliceSession, pair.bobSession, "second message");
    expect(again.decrypted).toBe("second message");
    const againReply = await sendAndDeliver(pair.bobSession, pair.aliceSession, "second reply");
    expect(againReply.decrypted).toBe("second reply");
  });

  it("tolerates out-of-order delivery via the skipped-key cache", async () => {
    // Alice sends three messages back-to-back; Bob receives them out of order.
    // NOTE: must be a sequential loop, not Promise.all — ratchetEncrypt
    // mutates shared session state across internal awaits, so concurrent
    // calls race and interleave that mutation non-deterministically.
    const sent: Array<{ header: RatchetMessageHeader; ciphertext: Uint8Array }> = [];
    for (let i = 0; i < 3; i++) {
      const { messageKey, header } = await ratchetEncrypt(pair.aliceSession);
      const ciphertext = await aesEncrypt(messageKey, `msg-${i}`);
      sent.push({ header, ciphertext });
    }

    // Arrival order: 2, 0, 1.
    const key2 = await ratchetDecrypt(pair.bobSession, sent[2]!.header);
    expect(await aesDecrypt(key2, sent[2]!.ciphertext)).toBe("msg-2");

    const key0 = await ratchetDecrypt(pair.bobSession, sent[0]!.header);
    expect(await aesDecrypt(key0, sent[0]!.ciphertext)).toBe("msg-0");

    const key1 = await ratchetDecrypt(pair.bobSession, sent[1]!.header);
    expect(await aesDecrypt(key1, sent[1]!.ciphertext)).toBe("msg-1");
  });

  it("refuses to re-derive a message key for an already-consumed message number", async () => {
    const { header } = await sendAndDeliver(pair.aliceSession, pair.bobSession, "only once");
    await expect(ratchetDecrypt(pair.bobSession, header)).rejects.toThrow(RatchetError);
  });

  it("refuses to re-derive a message key for an already-consumed skipped message (replay)", async () => {
    const sent: Array<{ header: RatchetMessageHeader; ciphertext: Uint8Array }> = [];
    for (let i = 0; i < 2; i++) {
      const { messageKey, header } = await ratchetEncrypt(pair.aliceSession);
      sent.push({ header, ciphertext: await aesEncrypt(messageKey, `msg-${i}`) });
    }
    // Deliver out of order (1 then 0) so message 0 is served from the skipped-key cache.
    await ratchetDecrypt(pair.bobSession, sent[1]!.header);
    await ratchetDecrypt(pair.bobSession, sent[0]!.header);
    // Replaying message 0 again must fail: it's been consumed and removed from the cache.
    await expect(ratchetDecrypt(pair.bobSession, sent[0]!.header)).rejects.toThrow(RatchetError);
  });
});
