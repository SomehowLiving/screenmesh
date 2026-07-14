import type { WebSocketRelayTransport } from "./websocket.js";

/**
 * WebRTC direct transfer (docs/Transports.md, Instant mode): encrypted
 * envelopes move browser-to-browser over a data channel; only signaling
 * (offers/answers/ICE) crosses the relay. The engine tries this channel
 * first and falls back to the relay, so a failed or still-connecting
 * peer connection costs nothing but the fallback.
 *
 * Glare avoidance: only the device with the lexicographically SMALLER id
 * creates offers; the other side asks for one with "request-offer".
 */

type SignalData =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "request-offer" };

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class WebRtcDirect {
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly channels = new Map<string, RTCDataChannel>();
  private messageHandlers: Array<(data: Uint8Array) => void> = [];

  constructor(
    private readonly relay: WebSocketRelayTransport,
    private readonly myDeviceId: string,
  ) {
    relay.subscribeSignal((from, data) => {
      void this.onSignal(from, data as SignalData).catch(() => {
        this.teardown(from);
      });
    });
  }

  static available(): boolean {
    return typeof RTCPeerConnection !== "undefined";
  }

  /** True if the bytes went out over an OPEN data channel. */
  trySend(peerId: string, data: Uint8Array): boolean {
    const channel = this.channels.get(peerId);
    if (channel?.readyState === "open") {
      channel.send(data as unknown as ArrayBuffer);
      return true;
    }
    // Not connected (yet) — kick off dialing so a later send can go direct.
    void this.ensurePeer(peerId);
    return false;
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandlers.push(handler);
  }

  /** True if a direct channel to this peer is currently open. */
  isDirect(peerId: string): boolean {
    return this.channels.get(peerId)?.readyState === "open";
  }

  close(): void {
    for (const peerId of [...this.peers.keys()]) this.teardown(peerId);
  }

  // --- internals ---

  private async ensurePeer(peerId: string): Promise<void> {
    if (this.peers.has(peerId)) return;
    if (this.myDeviceId < peerId) {
      await this.makeOffer(peerId);
    } else {
      // The peer with the smaller id owns offer creation.
      try {
        this.relay.sendSignal(peerId, { kind: "request-offer" } satisfies SignalData);
      } catch {
        /* relay down; a later attempt will retry */
      }
    }
  }

  private newPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(peerId, pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try {
          this.relay.sendSignal(peerId, {
            kind: "ice",
            candidate: event.candidate.toJSON(),
          } satisfies SignalData);
        } catch {
          /* relay down */
        }
      }
    };
    pc.ondatachannel = (event) => this.adoptChannel(peerId, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.teardown(peerId);
      }
    };
    return pc;
  }

  private adoptChannel(peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      const bytes =
        typeof event.data === "string"
          ? new TextEncoder().encode(event.data)
          : new Uint8Array(event.data as ArrayBuffer);
      for (const handler of this.messageHandlers) handler(bytes);
    };
    channel.onclose = () => {
      if (this.channels.get(peerId) === channel) this.channels.delete(peerId);
    };
    this.channels.set(peerId, channel);
  }

  private async makeOffer(peerId: string): Promise<void> {
    const pc = this.newPeerConnection(peerId);
    this.adoptChannel(peerId, pc.createDataChannel("mesh"));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.relay.sendSignal(peerId, {
      kind: "offer",
      sdp: offer.sdp ?? "",
    } satisfies SignalData);
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    switch (data.kind) {
      case "request-offer": {
        if (this.myDeviceId < from && !this.channels.get(from)) {
          this.teardown(from);
          await this.makeOffer(from);
        }
        break;
      }
      case "offer": {
        this.teardown(from);
        const pc = this.newPeerConnection(from);
        await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.relay.sendSignal(from, {
          kind: "answer",
          sdp: answer.sdp ?? "",
        } satisfies SignalData);
        break;
      }
      case "answer": {
        const pc = this.peers.get(from);
        if (pc && pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        }
        break;
      }
      case "ice": {
        const pc = this.peers.get(from);
        if (pc) await pc.addIceCandidate(data.candidate);
        break;
      }
      default:
        break;
    }
  }

  private teardown(peerId: string): void {
    this.channels.get(peerId)?.close();
    this.channels.delete(peerId);
    this.peers.get(peerId)?.close();
    this.peers.delete(peerId);
  }
}
