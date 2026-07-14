import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  EnvelopeJson,
  RelayClientMessage,
  RelayServerMessage,
} from "@screenmesh/protocol";
import type { WorkspaceRegistry } from "./registry.js";

const MAX_QUEUE_PER_DEVICE = 1000;

export interface RelayHandle {
  isOnline(deviceId: string): boolean;
  broadcastPresence(workspaceId: string): void;
  /** Force-close a device's connection and drop its queued envelopes. */
  disconnectDevice(deviceId: string): void;
}

async function verifyDeviceSignature(
  publicKeyB64: string,
  signatureB64: string,
  nonce: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKeyB64, "base64"),
      "Ed25519",
      true,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      Buffer.from(signatureB64, "base64"),
      new TextEncoder().encode(nonce),
    );
  } catch {
    return false;
  }
}

/**
 * Encrypted relay + store-and-forward queue (docs/Security.md §6).
 * Devices authenticate by signing a server nonce with their Ed25519 key.
 * Envelopes are routed on their cleartext header (recipientDeviceId);
 * payloads stay ciphertext end to end. Offline recipients get an
 * in-memory queue drained on reconnect.
 */
export async function registerRelay(
  app: FastifyInstance,
  registry: WorkspaceRegistry,
): Promise<RelayHandle> {
  const connections = new Map<string, WebSocket>();
  const queues = new Map<string, EnvelopeJson[]>();

  const isOnline = (deviceId: string): boolean => {
    const socket = connections.get(deviceId);
    return !!socket && socket.readyState === socket.OPEN;
  };

  const sendTo = (socket: WebSocket, msg: RelayServerMessage): void => {
    socket.send(JSON.stringify(msg));
  };

  const broadcastPresence = (workspaceId: string): void => {
    const devices = registry.presence(workspaceId, isOnline);
    if (devices.length === 0) return;
    const payload = JSON.stringify({ type: "presence", devices } satisfies RelayServerMessage);
    for (const deviceId of registry.deviceIds(workspaceId)) {
      const socket = connections.get(deviceId);
      if (socket && socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  app.get("/relay", { websocket: true }, (socket) => {
    const state: { deviceId?: string; workspaceId?: string; nonce: string } = {
      nonce: crypto.randomUUID(),
    };
    sendTo(socket, { type: "challenge", nonce: state.nonce });

    socket.on("message", (raw) => {
      void (async () => {
        let msg: RelayClientMessage;
        try {
          msg = JSON.parse(String(raw)) as RelayClientMessage;
        } catch {
          return sendTo(socket, { type: "error", reason: "malformed message" });
        }

        switch (msg.type) {
          case "auth": {
            if (registry.workspaceExpired(msg.workspaceId)) {
              return sendTo(socket, {
                type: "authError",
                reason: "workspace expired",
              });
            }
            const device = registry.getDevice(msg.workspaceId, msg.deviceId);
            if (!device) {
              return sendTo(socket, {
                type: "authError",
                reason: "device is not registered in this workspace",
              });
            }
            const ok = await verifyDeviceSignature(
              device.publicKey,
              msg.signature,
              state.nonce,
            );
            if (!ok) {
              return sendTo(socket, { type: "authError", reason: "bad signature" });
            }
            state.deviceId = msg.deviceId;
            state.workspaceId = msg.workspaceId;
            connections.set(msg.deviceId, socket);
            registry.touch(msg.workspaceId, msg.deviceId, Date.now());

            const queued = queues.get(msg.deviceId) ?? [];
            queues.delete(msg.deviceId);
            sendTo(socket, { type: "authOk", queued: queued.length });
            for (const envelope of queued) {
              if (envelope.expiresAt !== undefined && Date.now() > envelope.expiresAt) continue;
              sendTo(socket, { type: "envelope", envelope });
            }
            broadcastPresence(msg.workspaceId);
            break;
          }
          case "envelope": {
            if (!state.deviceId || !state.workspaceId) {
              return sendTo(socket, { type: "error", reason: "not authenticated" });
            }
            const envelope = msg.envelope;
            if (
              envelope.senderDeviceId !== state.deviceId ||
              envelope.workspaceId !== state.workspaceId
            ) {
              return sendTo(socket, { type: "error", reason: "sender mismatch" });
            }
            const target = connections.get(envelope.recipientDeviceId);
            if (target && target.readyState === target.OPEN) {
              sendTo(target, { type: "envelope", envelope });
            } else {
              const queue = queues.get(envelope.recipientDeviceId) ?? [];
              if (queue.length < MAX_QUEUE_PER_DEVICE) queue.push(envelope);
              queues.set(envelope.recipientDeviceId, queue);
            }
            break;
          }
          case "signal": {
            // WebRTC signaling: forwarded verbatim between authenticated
            // devices; payload media never touches the server.
            if (!state.deviceId || !state.workspaceId) {
              return sendTo(socket, { type: "error", reason: "not authenticated" });
            }
            if (!registry.getDevice(state.workspaceId, msg.to)) return;
            const peer = connections.get(msg.to);
            if (peer && peer.readyState === peer.OPEN) {
              sendTo(peer, { type: "signal", from: state.deviceId, data: msg.data });
            }
            break;
          }
          case "ping": {
            sendTo(socket, { type: "pong" });
            break;
          }
          default:
            break;
        }
      })();
    });

    socket.on("close", () => {
      if (state.deviceId && state.workspaceId) {
        if (connections.get(state.deviceId) === socket) {
          connections.delete(state.deviceId);
        }
        registry.touch(state.workspaceId, state.deviceId, Date.now());
        broadcastPresence(state.workspaceId);
      }
    });
  });

  const disconnectDevice = (deviceId: string): void => {
    queues.delete(deviceId);
    const socket = connections.get(deviceId);
    if (socket) {
      connections.delete(deviceId);
      socket.close();
    }
  };

  return { isOnline, broadcastPresence, disconnectDevice };
}
