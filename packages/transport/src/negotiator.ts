import type { MeshTransport, Peer } from "./transport.js";

/**
 * Transport negotiation: pick the best available route to a peer.
 * Priority (docs/Transports.md):
 *   1. Direct local peer connection
 *   2. WebRTC peer-to-peer
 *   3. Internet relay (WebSocket)
 *   4. Native nearby connection
 *   5. QR or file transfer
 *   6. No route → caller queues the bundle in the outbox (Eventual mode)
 */
export class TransportNegotiator {
  constructor(private readonly transports: MeshTransport[]) {}

  /**
   * Returns the first transport (in priority order) that can currently
   * reach the peer, or null — in which case the delivery layer keeps the
   * encrypted bundle queued.
   */
  async selectRoute(peer: Peer): Promise<MeshTransport | null> {
    for (const transport of this.transports) {
      const peers = await transport.discover().catch(() => []);
      if (peers.some((p) => p.deviceId === peer.deviceId)) {
        return transport;
      }
    }
    return null;
  }
}
