import type {
  Connection,
  MeshTransport,
  Peer,
  TransportStatus,
} from "./transport.js";

/**
 * QR transport, two roles:
 *  1. Pairing — the QR encodes the PairingPayload (identity, public key,
 *     single-use token, workspace, expiry). See packages/crypto/pairing.ts.
 *  2. Offline transfer — small encrypted objects (text, URLs, small sync
 *     bundles) encoded into one or more QR frames when no other route
 *     exists. Animated multi-frame QR is the phase-4 upgrade.
 */
export class QrTransport implements MeshTransport {
  readonly kind = "qr" as const;

  private messageHandlers: Array<(data: Uint8Array) => void> = [];
  private statusHandlers: Array<(status: TransportStatus) => void> = [];

  async discover(): Promise<Peer[]> {
    // QR has no ambient discovery — the user explicitly shows/scans a code.
    return [];
  }

  async connect(_peer: Peer): Promise<Connection> {
    throw new Error("QrTransport.connect not implemented yet");
  }

  async send(_data: Uint8Array): Promise<void> {
    // TODO(phase-1): chunk data into QR frames and render them for the
    // receiving device's camera.
    throw new Error("QrTransport.send not implemented yet");
  }

  async disconnect(): Promise<void> {}

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (status: TransportStatus) => void): void {
    this.statusHandlers.push(handler);
  }
}
