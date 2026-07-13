import {
  toBase64,
  type EnvelopeJson,
  type PresenceEntry,
  type RelayClientMessage,
  type RelayServerMessage,
} from "@screenmesh/protocol";
import type {
  Connection,
  MeshTransport,
  Peer,
  TransportStatus,
} from "./transport.js";

export interface RelayAuth {
  deviceId: string;
  workspaceId: string;
  /** Signs the server's challenge nonce with the device's Ed25519 key. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/**
 * WebSocket relay transport. The server forwards encrypted envelopes when
 * peer-to-peer fails and queues them for offline recipients; it only ever
 * sees ciphertext. Authentication: the server sends a nonce, the device
 * returns an Ed25519 signature over it. Reconnects with backoff.
 */
export class WebSocketRelayTransport implements MeshTransport {
  readonly kind = "websocket-relay" as const;

  private socket: WebSocket | null = null;
  private status: TransportStatus = "idle";
  private manuallyClosed = false;
  private retryDelayMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private presence: PresenceEntry[] = [];

  private messageHandlers: Array<(data: Uint8Array) => void> = [];
  private statusHandlers: Array<(status: TransportStatus) => void> = [];
  private presenceHandlers: Array<(devices: PresenceEntry[]) => void> = [];
  private authErrorHandlers: Array<(reason: string) => void> = [];

  constructor(
    private readonly relayWsUrl: string,
    private readonly auth: RelayAuth,
  ) {}

  get isConnected(): boolean {
    return this.status === "connected";
  }

  getPresence(): PresenceEntry[] {
    return this.presence;
  }

  /** Connect to the relay and authenticate. Resolves after authOk. */
  async open(): Promise<void> {
    this.manuallyClosed = false;
    await this.dial();
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relayWsUrl);
      this.socket = ws;
      this.setStatus("connecting");
      let settled = false;

      ws.onmessage = (event: MessageEvent) => {
        void (async () => {
          const text =
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer);
          let msg: RelayServerMessage;
          try {
            msg = JSON.parse(text) as RelayServerMessage;
          } catch {
            return;
          }
          switch (msg.type) {
            case "challenge": {
              const signature = await this.auth.sign(
                new TextEncoder().encode(msg.nonce),
              );
              this.sendRaw({
                type: "auth",
                deviceId: this.auth.deviceId,
                workspaceId: this.auth.workspaceId,
                signature: toBase64(signature),
              });
              break;
            }
            case "authOk": {
              this.retryDelayMs = 1000;
              this.setStatus("connected");
              if (!settled) {
                settled = true;
                resolve();
              }
              break;
            }
            case "authError": {
              // The relay rejected us (revoked device, expired workspace,
              // bad key). Retrying won't help — stop reconnecting and let
              // the app decide what to do.
              this.manuallyClosed = true;
              this.setStatus("error");
              for (const handler of this.authErrorHandlers) handler(msg.reason);
              ws.close();
              if (!settled) {
                settled = true;
                reject(new Error(`relay auth failed: ${msg.reason}`));
              }
              break;
            }
            case "envelope": {
              const bytes = new TextEncoder().encode(JSON.stringify(msg.envelope));
              for (const handler of this.messageHandlers) handler(bytes);
              break;
            }
            case "presence": {
              this.presence = msg.devices;
              for (const handler of this.presenceHandlers) handler(msg.devices);
              break;
            }
            default:
              break;
          }
        })();
      };

      ws.onclose = () => {
        this.socket = null;
        if (this.status !== "error") this.setStatus("disconnected");
        if (!this.manuallyClosed) this.scheduleReconnect();
        if (!settled) {
          settled = true;
          reject(new Error("relay connection closed during auth"));
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.manuallyClosed) {
        void this.dial().catch(() => {
          /* onclose schedules the next retry */
        });
      }
    }, delay);
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private sendRaw(msg: RelayClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("relay socket is not open");
    }
    this.socket.send(JSON.stringify(msg));
  }

  sendEnvelope(envelope: EnvelopeJson): void {
    this.sendRaw({ type: "envelope", envelope });
  }

  // --- MeshTransport interface ---

  async discover(): Promise<Peer[]> {
    return this.presence
      .filter((entry) => entry.online && entry.id !== this.auth.deviceId)
      .map((entry) => ({
        deviceId: entry.id,
        name: entry.name,
        transport: this.kind,
      }));
  }

  async connect(peer: Peer): Promise<Connection> {
    if (!this.isConnected) await this.open();
    return { peer, close: async () => {} };
  }

  /** Sends SecureEnvelope JSON bytes; the relay routes on the envelope header. */
  async send(data: Uint8Array): Promise<void> {
    const envelope = JSON.parse(new TextDecoder().decode(data)) as EnvelopeJson;
    this.sendEnvelope(envelope);
  }

  async disconnect(): Promise<void> {
    this.manuallyClosed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus("idle");
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandlers.push(handler);
  }

  onStatusChange(handler: (status: TransportStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  /** Relay-specific: presence roster updates. Returns an unsubscriber. */
  subscribePresence(handler: (devices: PresenceEntry[]) => void): () => void {
    this.presenceHandlers.push(handler);
    return () => {
      this.presenceHandlers = this.presenceHandlers.filter((h) => h !== handler);
    };
  }

  /** Like onStatusChange but returns an unsubscriber (for UI hooks). */
  subscribeStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
    };
  }

  /** Fired when the relay refuses authentication (revoked / expired). */
  subscribeAuthError(handler: (reason: string) => void): () => void {
    this.authErrorHandlers.push(handler);
    return () => {
      this.authErrorHandlers = this.authErrorHandlers.filter((h) => h !== handler);
    };
  }
}
