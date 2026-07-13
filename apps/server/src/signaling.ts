import type { FastifyInstance } from "fastify";

/**
 * WebRTC signaling: forwards offers, answers, and ICE candidates between
 * paired devices in the same workspace. Payload data never flows here —
 * once the peer connection opens, media moves device-to-device.
 */
export async function registerSignaling(app: FastifyInstance): Promise<void> {
  app.get("/signal", { websocket: true }, (socket) => {
    // TODO(phase-1): authenticate with a signed device challenge, then
    // route {offer, answer, ice} messages to the addressed deviceId.
    socket.on("message", () => {
      socket.send(JSON.stringify({ error: "signaling not implemented yet" }));
    });
  });
}
