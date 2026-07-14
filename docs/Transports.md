# ScreenMesh Transports

ScreenMesh treats Bluetooth, Wi-Fi, WebRTC, QR, audio, and future protocols as **interchangeable transports** behind one interface. The application layer never knows which one delivered an operation.

## The adapter interface

```ts
interface MeshTransport {
  discover(): Promise<Peer[]>;
  connect(peer: Peer): Promise<Connection>;
  send(data: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;

  onMessage(handler: (data: Uint8Array) => void): void;
  onStatusChange(handler: (status: TransportStatus) => void): void;
}
```

Adapters carry opaque ciphertext (`SecureEnvelope` bytes). The interface is deliberately shaped like the WICG **Local Peer-to-Peer API** proposal so that if browsers ever ship native local discovery + authenticated pairing + direct data channels, it becomes just another adapter.

## Negotiation priority

```text
1. Direct local peer connection
2. WebRTC peer-to-peer connection
3. Internet relay (WebSocket)
4. Native nearby connection
5. QR or file transfer
6. Queue until a route becomes available (store–carry–forward)
```

Which maps onto three operating modes:

| Mode | Condition | Transports |
|---|---|---|
| **Instant** | Common network or internet | WebRTC direct, WebSocket relay fallback |
| **Nearby** | No internet, physically close | QR/NFC pairing + Nearby/Wi-Fi transfer |
| **Eventual** | No usable route | Encrypted outbox → later encounter or trusted carrier |

## MVP adapters

### WebRTC (`webrtc.ts`)
Direct browser-to-browser data channels (`WebRtcDirect`). Offers/answers/ICE are forwarded verbatim between authenticated devices over the relay's `signal` messages; encrypted envelopes then move peer-to-peer. Glare is avoided by letting only the device with the lexicographically smaller id create offers (the other side sends `request-offer`). The engine tries the direct channel first on every send and falls back to the relay transparently, so a missing or still-connecting peer connection costs nothing.

### WebSocket relay (`websocket.ts`)
The server forwards encrypted envelopes when P2P fails — different networks, corporate NAT, one device reconnecting. Also provides the store-and-forward queue for offline recipients. The server never needs plaintext.

### QR (`qr.ts`)
Two roles:
1. **Pairing** — exchanging workspace ID, device identity, public key, pairing secret, expiry, and signaling hints. Cross-platform, accountless, explicitly authorized.
2. **Offline transfer** — encoding small encrypted objects (text, URLs, pairing credentials, small sync bundles) into one or more QR frames when no other route exists.

## Planned / researched adapters

Ranked from the connectivity research in [Techncial.md](../Techncial.md):

| Adapter | Novelty | Practicality | Status |
|---|---|---|---|
| Store–carry–forward delivery | High | High | **Core differentiator — build into sync layer** |
| QR-bootstrapped direct sync | Medium | High | **MVP** |
| Android Nearby Connections bridge | Medium | High | After PWA — thin native companion exposing Nearby (BT/BLE/Wi-Fi) to the PWA |
| Wi-Fi Aware | High | Medium | Optional high-throughput Android adapter; hardware-dependent |
| Apple Multipeer / Network.framework | Medium | Medium | Needed for a polished Apple experience |
| UWB "point-to-send" | Very high | Medium | Flagship demo — UWB does *targeting* (which screen the user points at); Wi-Fi/WebRTC does transfer |
| Bluetooth Channel Sounding | High | Low (today) | Watch — cm-level ranging for proximity UX, not a data channel |
| Screen-to-camera optical pairing | Very high | Medium | Hackathon experiment — visual channel bootstraps keys/identity, faster transport carries payloads |
| Ultrasonic/acoustic pairing | High | Low–medium | Discovery/key exchange only, never full sync |
| NFC tap-to-pair | Low | High | Passive tags on lab monitors/meeting displays — boring but practical |
| WICG Local Peer-to-Peer API | Very high | Not deployable | Track and shape the adapter interface around it |
| IWA Direct Sockets (raw TCP/UDP) | High | Restricted | Desktop research direction |
| LoRa / Meshtastic | High | Niche | Separate vertical (field notes off-grid) |

Two architectural lessons carried over from the research:

- **OpenHarmony DSoftBus pattern** — a unified device bus hiding the underlying link technology is the right shape; ScreenMesh is a smaller, cross-platform version of that idea.
- **Discovery/intent vs. payload transport are separate concerns** — UWB, Channel Sounding, NFC, optical, and acoustic channels are for *targeting and bootstrapping*; bulk data always moves over Wi-Fi/WebRTC/relay.
