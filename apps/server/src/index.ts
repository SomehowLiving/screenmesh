import os from "node:os";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { WorkspaceRegistry } from "./registry.js";
import { registerWorkspaceRoutes } from "./workspaces.js";
import { registerRelay, type RelayHandle } from "./relay.js";

/**
 * The ScreenMesh server is deliberately minimal — the system must degrade
 * gracefully without it (docs/Architecture.md §5). It provides:
 *   1. Workspace + pairing registry (device identities, public keys)
 *   2. An encrypted relay when P2P fails (ciphertext only)
 *   3. Store-and-forward queueing for offline devices
 *   4. Best-effort presence hints
 *   5. WebRTC signaling (offers/answers/ICE forwarded over the relay)
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

    scope.get("/health", async () => ({ ok: true }));

    /**
     * LAN addresses of this machine, so the PWA can build join links that
     * other devices on the network can actually reach.
     *
     * IP prefix alone is NOT a reliable signal: a VPN client (Pritunl,
     * WireGuard, Tailscale, ...) commonly hands out a 10.x address too,
     * which ties with a real 10.x LAN and can outrank it depending on
     * enumeration order — producing a join link that points at the VPN
     * tunnel, which other devices can't reach at all (silent timeout).
     * Rank primarily by INTERFACE NAME (deprioritize anything that looks
     * virtual/VPN/tunnel), then by IP prefix as a tiebreaker. Return every
     * candidate with its interface name so the UI can offer a manual
     * override if auto-detection still guesses wrong.
     */
    scope.get("/info", async () => {
      const VIRTUAL_NAME_PATTERN =
        /vpn|pritunl|tailscale|zerotier|wireguard|openvpn|nordlynx|tap|tun\d|ppp|utun|virtual|vethernet|hyper-v|wsl|docker|loopback/i;

      const candidates: Array<{ name: string; address: string }> = [];
      for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
        for (const iface of interfaces ?? []) {
          if (iface.family === "IPv4" && !iface.internal) {
            candidates.push({ name, address: iface.address });
          }
        }
      }

      const ipRank = (ip: string): number => {
        if (ip.startsWith("192.168.")) return 0;
        if (ip.startsWith("10.")) return 1;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
        return 3;
      };
      const score = (c: { name: string; address: string }): number =>
        (VIRTUAL_NAME_PATTERN.test(c.name) ? 100 : 0) + ipRank(c.address);

      candidates.sort((a, b) => score(a) - score(b));
      return {
        addresses: candidates.map((c) => c.address),
        interfaces: candidates,
      };
    });
  },
  { prefix: "/api" },
);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });
