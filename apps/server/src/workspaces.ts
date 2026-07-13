import type { FastifyInstance } from "fastify";
import type {
  CreateWorkspaceRequest,
  JoinWorkspaceRequest,
  RevokeDeviceRequest,
  RotatePairingRequest,
} from "@screenmesh/protocol";
import { isRegistryError, type WorkspaceRegistry } from "./registry.js";

/**
 * Pairing HTTP API. Creating a workspace registers the owner device and
 * the first pairing token; joining redeems a token (single-use). The
 * server stores device identities and public keys — never key material
 * for payload encryption (that travels inside the QR).
 */
export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  registry: WorkspaceRegistry,
  relay: {
    isOnline(deviceId: string): boolean;
    broadcastPresence(workspaceId: string): void;
    disconnectDevice(deviceId: string): void;
  },
): Promise<void> {
  const { isOnline, broadcastPresence } = relay;
  app.post("/workspaces", async (req, reply) => {
    const body = req.body as CreateWorkspaceRequest;
    if (!body?.workspace?.id || !body.device?.id || !body.device.publicKey || !body.pairingToken) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const err = registry.create(body);
    if (err) return reply.code(err.code).send({ error: err.message });
    return reply.code(201).send({ ok: true });
  });

  app.post("/workspaces/:id/join", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as JoinWorkspaceRequest;
    if (!body?.pairingToken || !body.device?.id || !body.device.publicKey) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const result = registry.join(id, body, isOnline);
    if (isRegistryError(result)) {
      return reply.code(result.code).send({ error: result.message });
    }
    broadcastPresence(id);
    return reply.send(result);
  });

  app.post("/workspaces/:id/pairing-token", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as RotatePairingRequest;
    if (!body?.deviceId || !body.pairingToken) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const err = registry.rotatePairing(id, body.deviceId, body.pairingToken, body.tokenExpiresAt);
    if (err) return reply.code(err.code).send({ error: err.message });
    return reply.send({ ok: true });
  });

  app.post("/workspaces/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as RevokeDeviceRequest;
    if (!body?.ownerDeviceId || !body.deviceId) {
      return reply.code(400).send({ error: "invalid request" });
    }
    const err = registry.removeDevice(id, body.ownerDeviceId, body.deviceId);
    if (err) return reply.code(err.code).send({ error: err.message });
    relay.disconnectDevice(body.deviceId);
    broadcastPresence(id);
    return reply.send({ ok: true });
  });
}
