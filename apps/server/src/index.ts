import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { WorkspaceRegistry } from "./registry.js";
import { registerWorkspaceRoutes } from "./workspaces.js";
import { registerRelay } from "./relay.js";
import { registerSignaling } from "./signaling.js";

/**
 * The ScreenMesh server is deliberately minimal — the system must degrade
 * gracefully without it (docs/Architecture.md §5). It provides:
 *   1. Workspace + pairing registry (device identities, public keys)
 *   2. An encrypted relay when P2P fails (ciphertext only)
 *   3. Store-and-forward queueing for offline devices
 *   4. Best-effort presence hints
 *   5. WebSocket signaling for WebRTC (offers/answers/ICE) — upcoming
 * It never sees plaintext user content.
 */
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

const registry = new WorkspaceRegistry();
const relay = await registerRelay(app, registry);
await registerWorkspaceRoutes(app, registry, relay.isOnline, relay.broadcastPresence);
await registerSignaling(app);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });
