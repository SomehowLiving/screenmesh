# Transport Strategy

ScreenMesh is built on one architectural bet:

> Notes, clipboard items, screenshots, files, and commands move between devices using whichever path is currently available — and remain queued when no path exists.

Every connection method — WebRTC, a relay, Bluetooth, Wi-Fi, sound, an animated QR code — is an interchangeable adapter behind one interface. The application never asks which one carried a message. This document lays out the transport landscape, why the current set was chosen, and where the frontier still is.

---

## The interface everything implements

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

Any transport that can move bytes between two paired devices can sit behind this. That's what makes the fleet below additive rather than a series of rewrites: adding acoustic support didn't touch WebRTC, and adding Wi-Fi Direct didn't touch BLE.

---

## The core transports

**WebRTC** carries the bulk of everyday traffic — notes, clipboard items, images, files, presence — as a direct browser-to-browser data channel whenever both devices can reach each other. Lowest latency, no server in the payload path.

**A WebSocket relay** is the fallback for everything WebRTC can't reach: different networks, restrictive NAT, a device mid-reconnect. It authenticates every device with a signed challenge and forwards ciphertext only — it's infrastructure, not a trust boundary, and it's built deliberately lean (no database, no object storage) since it was never meant to be the system of record.

**QR pairing** is the trust ceremony for both of the above: one scan carries a workspace ID, a device identity, a pairing token, and key material. No typing, no accounts, works on nearly any phone — which is why it's the default rather than an optional extra.

**Store–carry–forward** is the piece that makes the other two resilient rather than merely convenient. When a destination device is offline, an encrypted delivery bundle can sit on the sender, on the relay's queue, or ride along on a third trusted device that later happens to meet the real destination — without that third device ever being able to read what it's carrying, since only the true destination's own session key can open it.

```text
Phone → Laptop: send note
Laptop is offline.
Phone meets Tablet — Tablet holds the encrypted bundle, unreadable to it.
Tablet later meets Laptop — Laptop receives and decrypts the note.
```

Most shared apps look like `device → cloud → device`. This one looks like `device → any available route → destination` — and that's the actual differentiator, not any single transport on the list.

---

## Nearby transports on Android

A phone rarely has continuous internet or a shared network with the device sitting next to it, so a real native companion needed transports that don't depend on either:

**Bluetooth LE** — implemented directly against `android.bluetooth` as a genuine GATT peripheral-and-central pair (not a wrapper around a third-party SDK), doubling as both a raw envelope transport and a nearby-pairing bootstrap through an extra read-only characteristic.

**Wi-Fi Direct** — `WifiP2pManager` for peer discovery, then a plain TCP socket once a group forms. Higher throughput than BLE, no MTU fragmentation to worry about, used once two devices already know about each other rather than for the initial handshake.

**NFC** — tap-to-pair via NDEF read/write against a passive tag, reusing the exact same pairing-code format the QR code carries. The least glamorous of the four and, in practice, the most foolproof — a tap is unambiguous in a way "scan the right QR" sometimes isn't in a crowded room.

**Acoustic (near-ultrasonic)** — a mic/speaker data link for the case where there's no radio at all: no Bluetooth, no shared Wi-Fi, nothing. Rather than building an audio modem from scratch, this vendors a pure-Kotlin implementation from the open-source `cyrinx` project and wraps it behind the same `MeshTransport` interface as everything else. It's genuinely slow — well under a kilobit per second, capped at a few kilobytes per message — so it's positioned for exactly what that limit suits: a pairing code or a short note within earshot of a working mic and speaker, not bulk transfer. It's also the one transport here with no multi-peer discovery at all — a single half-duplex link between whichever two devices are close enough to hear each other, so one side has to be told it's the initiator and the other the responder.

Together, BLE and NFC handle the nearby pairing handshake; Wi-Fi Direct and acoustic handle nearby data transfer once devices are already paired — the same discovery/transfer split the relay and WebRTC use at internet scale, just replicated at arm's length.

---

## Spatial targeting: pointing instead of choosing from a list

A device list works, but "point your phone at the laptop you mean" is a genuinely better interaction when the hardware supports it. The right way to build this keeps targeting and transport strictly separate:

```text
Discovery and intent → UWB / Bluetooth Channel Sounding
Payload transport     → whatever transport is already negotiated
```

UWB (Apple's Nearby Interaction, Android's Core UWB library) and Bluetooth Channel Sounding both expose distance and, in some cases, direction to a nearby device — enough to say "that one, not the other three" without ever carrying a byte of the actual payload. This is a strong interaction to build once the underlying sync layer is solid; it makes a poor foundation to build on top of, since it answers "which device" and nothing about "how do the bytes get there."

---

## Physical side channels for bootstrapping

**Screen-to-camera pairing.** A screen can encode a peer identity, an ephemeral key, and connection metadata into an animated QR sequence or an imperceptible brightness/color modulation, read by a phone's camera. The interesting version doesn't try to send the actual note through the camera — it uses the visual channel only to bootstrap a faster one:

```text
Screen → camera: identity + keys + connection metadata
Wi-Fi/WebRTC: the actual notes and files
```

This is the same "bootstrap over a slow, robust channel; transfer over a fast one" pattern the acoustic transport already follows for audio — worth extending to optical once there's a reason to pair without a QR code specifically (no camera access to a code, a locked-down kiosk display, a room-scale demo).

**Acoustic pairing, more narrowly than the full transport above.** A short chirp encoding a room ID and a key fingerprint is one of the lowest-friction possible pairing methods — every phone and laptop already has the hardware, no permissions dialog beyond the microphone, and it can broadcast to several listeners at once. The tradeoffs (background noise, payload size, audio-processing differences across devices) are exactly why it's better suited to bootstrapping a connection than carrying one.

---

## What's being watched, not built

A few directions are tracked deliberately rather than adopted, because either the underlying platform support isn't there yet or the payoff doesn't clear the cost of a dedicated implementation right now:

**A browser-native local peer-to-peer API.** A WICG proposal for discovery, authenticated pairing, and QUIC-based local communication directly from the browser — exactly the shape this system's own transport interface already assumes, which is precisely why it's worth designing around even before it ships anywhere.

**Isolated Web Apps with raw TCP/UDP sockets.** Chrome's Direct Sockets API would let a desktop web app open real local-network connections without a native companion at all — currently gated to enterprise-managed ChromeOS, so it's a research direction for the desktop story rather than something to build against today.

**Vendor-specific device fabrics** (Huawei's NearLink, OpenHarmony's Distributed SoftBus, OEM-extended Bluetooth ranges from OPPO/Xiaomi) prove that a single vendor with control over silicon, firmware, and OS can push a given radio much further than any cross-platform API can reach — useful as inspiration for what's eventually possible, not something to build a cross-vendor product against.

**LoRa-based mesh messaging** opens a genuinely different vertical — off-grid field notes for treks, disaster response, or remote sites — but needs external radio hardware and offers limited bandwidth, so it stays a separate, later product rather than a core transport.

The common thread across this list: each one is either an API for a specific ecosystem (Apple, HarmonyOS, ChromeOS Enterprise) or a proposal that hasn't shipped as a stable standard yet. None of them change the interface described at the top of this document if and when they do arrive — that's the point of building against an interface instead of a specific protocol.
