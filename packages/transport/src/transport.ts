/**
 * The single interface every transport adapter implements. Adapters carry
 * opaque ciphertext (SecureEnvelope bytes) — never plaintext. The shape
 * deliberately resembles the WICG Local Peer-to-Peer API proposal so a
 * native browser implementation can become just another adapter.
 * See docs/Transports.md.
 */

export interface Peer {
  deviceId: string;
  name: string;
  /** Which transport discovered this peer. */
  transport: TransportKind;
}

export type TransportKind =
  | "webrtc"
  | "websocket-relay"
  | "qr"
  | "nearby"
  | "lan"
  | "local-p2p";

export type TransportStatus =
  | "idle"
  | "discovering"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface Connection {
  peer: Peer;
  close(): Promise<void>;
}

export interface MeshTransport {
  readonly kind: TransportKind;

  discover(): Promise<Peer[]>;
  connect(peer: Peer): Promise<Connection>;
  send(data: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;

  onMessage(handler: (data: Uint8Array) => void): void;
  onStatusChange(handler: (status: TransportStatus) => void): void;
}
