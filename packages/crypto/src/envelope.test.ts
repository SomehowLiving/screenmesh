import { beforeEach, describe, expect, it } from "vitest";
import { decryptEnvelope, sealEnvelope, verifyEnvelope, type SealParams } from "./envelope.js";
import { generateIdentity, type DeviceIdentity } from "./identity.js";
import { initRatchetSession, ratchetDecrypt, ratchetEncrypt, type RatchetSession } from "./ratchet.js";

const WORKSPACE_ID = "workspace-1";

interface Ctx {
  alice: DeviceIdentity;
  bob: DeviceIdentity;
  aliceSession: RatchetSession;
  bobSession: RatchetSession;
}

async function bootstrap(): Promise<Ctx> {
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

/** Alice seals a real envelope carrying `plaintext`, ratchet-encrypted for real. */
async function sealFromAlice(
  ctx: Ctx,
  plaintext: string,
  overrides: Partial<Pick<SealParams, "createdAt" | "expiresAt" | "sequenceNumber">> = {},
) {
  const { messageKey, header } = await ratchetEncrypt(ctx.aliceSession);
  return sealEnvelope({
    identity: ctx.alice,
    recipientDeviceId: ctx.bob.deviceId,
    workspaceId: WORKSPACE_ID,
    messageKey,
    ratchetHeader: header,
    plaintext: new TextEncoder().encode(plaintext),
    sequenceNumber: overrides.sequenceNumber ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
  });
}

/** Bob's side of the real receive path: verify (already done by caller), derive the ratchet key, decrypt. */
async function receiveAsBob(ctx: Ctx, env: Awaited<ReturnType<typeof sealFromAlice>>) {
  const messageKey = await ratchetDecrypt(ctx.bobSession, {
    ratchetPublicKeyB64: env.ratchetPublicKeyB64,
    messageNumber: env.messageNumber,
    previousChainLength: env.previousChainLength,
  });
  return decryptEnvelope(env, messageKey);
}

describe("sealEnvelope / verifyEnvelope / decryptEnvelope", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await bootstrap();
  });

  it("round-trips plaintext through the real seal -> verify -> ratchet-decrypt -> decrypt path", async () => {
    const env = await sealFromAlice(ctx, "hello bob");
    await verifyEnvelope(env, ctx.alice.publicKey, Date.now());
    const plaintext = await receiveAsBob(ctx, env);
    expect(new TextDecoder().decode(plaintext)).toBe("hello bob");
  });

  it("fails verification if the ciphertext is tampered with", async () => {
    const env = await sealFromAlice(ctx, "hello bob");
    const tampered = { ...env, ciphertext: new Uint8Array(env.ciphertext) };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    await expect(verifyEnvelope(tampered, ctx.alice.publicKey, Date.now())).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("fails verification if the signature is tampered with", async () => {
    const env = await sealFromAlice(ctx, "hello bob");
    const tampered = { ...env, signature: new Uint8Array(env.signature) };
    tampered.signature[0] = tampered.signature[0]! ^ 0xff;
    await expect(verifyEnvelope(tampered, ctx.alice.publicKey, Date.now())).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("fails verification if a field outside the signed set is swapped (e.g. recipientDeviceId)", async () => {
    // canonicalBytes includes recipientDeviceId, so redirecting a captured
    // envelope to a different recipient must also break the signature.
    const env = await sealFromAlice(ctx, "hello bob");
    const redirected = { ...env, recipientDeviceId: "some-other-device" };
    await expect(verifyEnvelope(redirected, ctx.alice.publicKey, Date.now())).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("fails verification if checked against the wrong sender's public key", async () => {
    const impostor = await generateIdentity();
    const env = await sealFromAlice(ctx, "hello bob");
    await expect(verifyEnvelope(env, impostor.publicKey, Date.now())).rejects.toThrow(
      /invalid signature/,
    );
  });

  it("fails verification on an expired envelope even with an otherwise-valid signature", async () => {
    const now = Date.now();
    const env = await sealFromAlice(ctx, "hello bob", { createdAt: now - 1000, expiresAt: now - 500 });
    await expect(verifyEnvelope(env, ctx.alice.publicKey, now)).rejects.toThrow(/expired/);
  });

  it("does not throw on expiry when checked before expiresAt", async () => {
    const now = Date.now();
    const env = await sealFromAlice(ctx, "hello bob", { createdAt: now, expiresAt: now + 60_000 });
    await expect(verifyEnvelope(env, ctx.alice.publicKey, now)).resolves.not.toThrow();
  });
});
