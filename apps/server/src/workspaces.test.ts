import Fastify from "fastify";
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
import { WorkspaceRegistry } from "./registry.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

async function signedRotation(
  workspaceId: string,
  owner: Awaited<ReturnType<typeof generateIdentity>>,
): Promise<RotatePairingRequest> {
  const unsigned = {
    deviceId: owner.deviceId,
    pairingToken: randomId(),
    tokenExpiresAt: Date.now() + 5 * 60_000,
    issuedAt: Date.now(),
    nonce: randomId(),
  };
  return {
    ...unsigned,
    signature: toBase64(await sign(owner, pairingRotationAuthorizationBytes(workspaceId, unsigned))),
  };
}

describe("POST /workspaces/:id/pairing-token", () => {
  it("requires a current owner signature and rejects a replay", async () => {
    const workspaceId = "workspace-test";
    const owner = await generateIdentity();
    const registry = new WorkspaceRegistry();
    registry.create({
      workspace: { id: workspaceId, name: "Test", createdAt: Date.now() },
      device: {
        id: owner.deviceId,
        name: "Owner",
        publicKey: await exportPublicKey(owner.publicKey),
        type: "desktop",
      },
      pairingToken: randomId(),
      tokenExpiresAt: Date.now() + 60_000,
    });
    const app = Fastify();
    await registerWorkspaceRoutes(app, registry, {
      isOnline: () => false,
      broadcastPresence: () => undefined,
      disconnectDevice: () => undefined,
    });
    const request = await signedRotation(workspaceId, owner);

    const accepted = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pairing-token`,
      payload: request,
    });
    expect(accepted.statusCode).toBe(200);

    const replayed = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pairing-token`,
      payload: request,
    });
    expect(replayed.statusCode).toBe(409);

    const tampered = { ...await signedRotation(workspaceId, owner), pairingToken: randomId() };
    const rejected = await app.inject({
      method: "POST",
      url: `/workspaces/${workspaceId}/pairing-token`,
      payload: tampered,
    });
    expect(rejected.statusCode).toBe(403);
    await app.close();
  });
});
