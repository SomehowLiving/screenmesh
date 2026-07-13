import os from "node:os";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { WorkspaceRegistry } from "./registry.js";
import { registerWorkspaceRoutes } from "./workspaces.js";
import { registerRelay, type RelayHandle } from "./relay.js";
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
 *
 * All routes live under /api so the Vite dev server can proxy them
 * same-origin (page, pairing API, and relay WebSocket share one origin).
 */
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

const registry = new WorkspaceRegistry();
let relay!: RelayHandle;

await app.register(
  async (scope) => {
    relay = await registerRelay(scope, registry);
    await registerWorkspaceRoutes(scope, registry, relay);
    await registerSignaling(scope);

    scope.get("/health", async () => ({ ok: true }));

    /** LAN addresses of this machine, so the PWA can build join links
     *  that other devices on the network can actually reach. Typical
     *  home/office LANs are 192.168.* or 10.*; 172.16–31.* is usually a
     *  WSL/Docker/Hyper-V virtual adapter, so rank it last. */
    scope.get("/info", async () => {
      const addresses: string[] = [];
      for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces ?? []) {
          if (iface.family === "IPv4" && !iface.internal) {
            addresses.push(iface.address);
          }
        }
      }
      const rank = (ip: string): number => {
        if (ip.startsWith("192.168.")) return 0;
        if (ip.startsWith("10.")) return 1;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 3;
        return 2;
      };
      addresses.sort((a, b) => rank(a) - rank(b));
      return { addresses };
    });
  },
  { prefix: "/api" },
);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });
