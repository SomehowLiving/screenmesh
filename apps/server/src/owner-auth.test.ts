import { describe, expect, it } from "vitest";
import {
  exportPublicKey,
  generateIdentity,
  randomId,
  sign,
} from "@screenmesh/crypto";
import {
  pairingRotationAuthorizationBytes,
  toBase64,
  type RotatePairingRequest,
} from "@screenmesh/protocol";
import { verifyPairingRotationAuthorization } from "./owner-auth.js";

async function signedRequest(now: number): Promise<{ publicKey: string; request: RotatePairingRequest }> {
  const identity = await generateIdentity();
  const unsigned = {
    deviceId: identity.deviceId,
    pairingToken: randomId(),
    tokenExpiresAt: now + 5 * 60_000,
    issuedAt: now,
    nonce: randomId(),
  };
  return {
    publicKey: await exportPublicKey(identity.publicKey),
    request: {
      ...unsigned,
      signature: toBase64(await sign(identity, pairingRotationAuthorizationBytes("workspace-1", unsigned))),
    },
  };
}

describe("verifyPairingRotationAuthorization", () => {
  it("accepts an owner signature covering the exact rotation request", async () => {
    const now = Date.now();
    const { publicKey, request } = await signedRequest(now);
    await expect(verifyPairingRotationAuthorization({ workspaceId: "workspace-1", ownerPublicKey: publicKey, request, now })).resolves.toBe(true);
  });

  it("rejects a token changed after the owner signed", async () => {
    const now = Date.now();
    const { publicKey, request } = await signedRequest(now);
    const tampered = { ...request, pairingToken: randomId() };
    await expect(verifyPairingRotationAuthorization({ workspaceId: "workspace-1", ownerPublicKey: publicKey, request: tampered, now })).resolves.toBe(false);
  });

  it("rejects stale signed requests", async () => {
    const now = Date.now();
    const { publicKey, request } = await signedRequest(now - 61_000);
    await expect(verifyPairingRotationAuthorization({ workspaceId: "workspace-1", ownerPublicKey: publicKey, request, now })).resolves.toBe(false);
  });
});
