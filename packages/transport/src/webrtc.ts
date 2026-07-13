import type {
  Connection,
  MeshTransport,
  Peer,
  TransportStatus,
} from "./transport.js";

/**
 * WebRTC data-channel transport: direct browser-to-browser transfer.
 * Best for low latency and large files when both devices are online and
 * a peer connection can be established. Signaling goes through the relay
 * server (apps/server); payloads never do.
 */
export class WebRtcTransport implements MeshTransport {
  readonly kind = "webrtc" as const;

  private messageHandlers: Array<(data: Uint8Array) => void> = [];
  private statusHandlers: Array<(status: TransportStatus) => void> = [];

  constructor(private readonly signalingUrl: string) {}

  async discover(): Promise<Peer[]> {
    // TODO(phase-1): query the signaling server for online paired peers.
    return [];
  }

  async connect(_peer: Peer): Promise<Connection> {
    // TODO(phase-1): create RTCPeerConnection, exchange offer/answer/ICE
    // via the signaling server, open a reliable ordered data channel.
    throw new Error("WebRtcTransport.connect not implemented yet");
  }

  async send(_data: Uint8Array): Promise<void> {
    throw new Error("WebRtcTransport.send not implemented yet");
  }

  async disconnect(): Promise<void> {}

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (status: TransportStatus) => void): void {
    this.statusHandlers.push(handler);
  }
}
