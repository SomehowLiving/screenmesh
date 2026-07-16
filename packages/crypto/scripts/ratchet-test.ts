/**
 * Standalone correctness test for the ratchet primitives, run BEFORE
 * wiring them into the engine so bugs are caught close to the math.
 * Run: pnpm exec tsx packages/crypto/scripts/ratchet-test.ts
 */
import {
  generateIdentity,
  generateWorkspaceKey,
  exportRawWorkspaceKey,
} from "../src/index.js";
import {
  initRatchetSession,
  ratchetEncrypt,
  ratchetDecrypt,
  type RatchetSession,
} from "../src/ratchet.js";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

async function aesEncrypt(key: CryptoKey, text: string): Promise<{ nonce: Uint8Array; ct: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, new TextEncoder().encode(text)),
  );
  return { nonce, ct };
}

async function aesDecrypt(key: CryptoKey, nonce: Uint8Array, ct: Uint8Array): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}

async function main(): Promise<void> {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const workspaceId = "ws1";
  const pairingSecret = await exportRawWorkspaceKey(await generateWorkspaceKey());

  const sessionA: RatchetSession = await initRatchetSession({
    workspaceId,
    myDeviceId: a.deviceId,
    myIdentityPublic: a.encryptionPublicKey,
    myIdentityPrivate: a.encryptionPrivateKey,
    peerDeviceId: b.deviceId,
    peerIdentityPublic: b.encryptionPublicKey,
    pairingSecret,
  });
  const sessionB: RatchetSession = await initRatchetSession({
    workspaceId,
    myDeviceId: b.deviceId,
    myIdentityPublic: b.encryptionPublicKey,
    myIdentityPrivate: b.encryptionPrivateKey,
    peerDeviceId: a.deviceId,
    peerIdentityPublic: a.encryptionPublicKey,
    pairingSecret,
  });

  // 1. A sends first, B decrypts.
  const enc1 = await ratchetEncrypt(sessionA);
  const wire1 = await aesEncrypt(enc1.messageKey, "hello from A, message 0");
  const key1 = await ratchetDecrypt(sessionB, enc1.header);
  assert((await aesDecrypt(key1, wire1.nonce, wire1.ct)) === "hello from A, message 0", "msg 0 A->B");
  console.log("[1/7] A sends first message (identity-key bootstrap); B decrypts correctly");

  // 2. A sends again on the same chain.
  const enc2 = await ratchetEncrypt(sessionA);
  const wire2 = await aesEncrypt(enc2.messageKey, "hello from A, message 1");
  const key2 = await ratchetDecrypt(sessionB, enc2.header);
  assert((await aesDecrypt(key2, wire2.nonce, wire2.ct)) === "hello from A, message 1", "msg 1 A->B");
  console.log("[2/7] second message on the same chain decrypts correctly");

  // 3. B replies — this triggers B's first DH ratchet step (fresh ephemeral key)
  //    and, once A processes it, A's fresh ephemeral key too (the "heal").
  const enc3 = await ratchetEncrypt(sessionB);
  const wire3 = await aesEncrypt(enc3.messageKey, "hi A, from B");
  const key3 = await ratchetDecrypt(sessionA, enc3.header);
  assert((await aesDecrypt(key3, wire3.nonce, wire3.ct)) === "hi A, from B", "msg 0 B->A");
  assert(
    enc3.header.ratchetPublicKeyB64 !== enc1.header.ratchetPublicKeyB64,
    "B's ratchet key should differ from A's original identity-bootstrap key",
  );
  console.log("[3/7] B's reply triggers a real DH ratchet step; A decrypts it");

  // 4. A replies again — should now use FRESH ephemeral material, not identity keys.
  const enc4 = await ratchetEncrypt(sessionA);
  assert(
    enc4.header.ratchetPublicKeyB64 !== enc1.header.ratchetPublicKeyB64,
    "A's post-heal ratchet key must differ from its original identity key",
  );
  const wire4 = await aesEncrypt(enc4.messageKey, "back to you, B");
  const key4 = await ratchetDecrypt(sessionB, enc4.header);
  assert((await aesDecrypt(key4, wire4.nonce, wire4.ct)) === "back to you, B", "post-heal A->B");
  console.log("[4/7] post-heal round trip uses fresh ephemeral keys on both sides");

  // 5. Out-of-order delivery within a single chain: B sends 3 messages,
  //    A receives them 2, 0, 1 (simulating outbox/carry reordering).
  const out5 = [];
  for (let i = 0; i < 3; i++) {
    const enc = await ratchetEncrypt(sessionB);
    const wire = await aesEncrypt(enc.messageKey, `out-of-order ${i}`);
    out5.push({ header: enc.header, wire });
  }
  const order = [2, 0, 1];
  for (const i of order) {
    const key = await ratchetDecrypt(sessionA, out5[i].header);
    const text = await aesDecrypt(key, out5[i].wire.nonce, out5[i].wire.ct);
    assert(text === `out-of-order ${i}`, `out-of-order message ${i} should decrypt correctly`);
  }
  console.log("[5/7] out-of-order delivery within a chain recovers via the skipped-key cache");

  // 6. A duplicate/replayed message (already consumed, not skipped) must fail.
  let duplicateRejected = false;
  try {
    await ratchetDecrypt(sessionA, out5[0].header);
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, "re-decrypting an already-consumed, non-skipped message must fail");
  console.log("[6/7] replayed/already-consumed message is correctly rejected");

  // 7. Reordering that spans a DH ratchet step: A sends 2 messages, B only
  //    receives the second one first (message 0 arrives "late" after B
  //    has already replied and ratcheted forward).
  const encX0 = await ratchetEncrypt(sessionA);
  const wireX0 = await aesEncrypt(encX0.messageKey, "late arrival 0");
  const encX1 = await ratchetEncrypt(sessionA);
  const wireX1 = await aesEncrypt(encX1.messageKey, "late arrival 1");
  // B processes message 1 first (0 is "still in flight" via outbox).
  const keyX1 = await ratchetDecrypt(sessionB, encX1.header);
  assert((await aesDecrypt(keyX1, wireX1.nonce, wireX1.ct)) === "late arrival 1", "message 1 arrives first");
  // B replies, ratcheting forward past the chain message 0 belongs to.
  const encReply = await ratchetEncrypt(sessionB);
  await ratchetDecrypt(sessionA, encReply.header);
  // Message 0 finally arrives, from the now-superseded chain.
  const keyX0 = await ratchetDecrypt(sessionB, encX0.header);
  assert((await aesDecrypt(keyX0, wireX0.nonce, wireX0.ct)) === "late arrival 0", "message 0 arrives late, across a ratchet step");
  console.log("[7/7] late arrival spanning a DH ratchet step recovers via previousChainLength draining");

  console.log("RATCHET TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
