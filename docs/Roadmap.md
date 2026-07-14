# ScreenMesh Roadmap

The core interaction to validate:

> Can a user move temporary information across devices faster and more naturally than sending it to themselves?

## Phase 0 — Scaffold ✅

- Monorepo, shared types, adapter interfaces, docs.

## Phase 1 — MVP: QR-bootstrapped handoff ✅

**Pairing & identity**
- [x] Accountless device identity (Ed25519 signing + X25519 key agreement, generated locally)
- [x] Workspace creation + QR / join-link pairing (single-use, expiring tokens; owner-minted)
- [x] Workspace expiry (optional TTL at creation; relay refuses expired workspaces; clients clean up)
- [x] Device revocation (owner-only; relay access cut immediately, roster pruned everywhere, workspace key rotated)

**Objects**
- [x] Text, links, code snippets
- [x] Images and small files (≤ 5 MB, base64 in encrypted envelopes; inline image preview + download)
- [x] Checklists (toggle/add items on any device; last-write-wins merge)
- [ ] Chunked transfer for larger files over WebRTC

**Sync**
- [x] IndexedDB local storage (Dexie)
- [x] Real-time relay sync (authenticated WebSocket, Ed25519 challenge)
- [x] Offline queues on both sides: client outbox drains on reconnect; relay store-and-forward for offline recipients
- [x] WebRTC direct transfer (data channels, relay-forwarded signaling, automatic relay fallback)
- [x] CRDT editing (Yjs): concurrent text edits merge instead of overwriting

**Device interactions**
- [x] Device dashboard with live presence; shared objects board
- [x] Send to one, several, or all devices (offline recipients get it on return)
- [x] Delivery status lifecycle: queued → sending → delivered → opened
- [x] Leave workspace (local cleanup; also triggered by revocation/expiry)
- [x] Continue-on-device (hands the object off and auto-opens the editor on the target)

**Security**
- [x] End-to-end encrypted envelopes (AES-GCM workspace key + Ed25519 signatures)
- [x] Replay protection: message-ID dedupe, sequence numbers, envelope expiry
- [x] Workspace key rotation on revocation: new key wrapped per-device via X25519 ECDH, epoch-tagged envelopes; revoked devices cannot unwrap post-rotation traffic

## Phase 2 — Eventual delivery

- Store–carry–forward: encrypted `DeliveryBundle`s carried by trusted intermediary devices (hop limits, expiry)
- Relay-side store-and-forward for offline recipients
- Expiring objects (after N minutes / after opening / with workspace)
- Delivery options: *deliver when device returns*, *delete after opening*, *require confirmation*

## Phase 3 — Native nearby

- Thin Android companion bridging Google Nearby Connections (Bluetooth/BLE/Wi-Fi) to the PWA
- Wi-Fi Aware as an optional high-throughput adapter
- NFC tap-to-pair via passive tags on shared displays

## Phase 4 — Flagship experiments

- UWB / Channel Sounding "point-to-send" targeting
- Screen-to-camera optical pairing (animated QR → invisible modulation)
- Ultrasonic discovery chirps
- Apple Multipeer / Network.framework adapter

## Phase 5 — Toward the device bus

- Forward-secret ratcheting sessions (Noise / Double Ratchet / MLS)
- Trusted desktop agent with approval-gated command execution
- Temporary clipboard tunnel; secure file drop
- Capability routing: devices expose selected capabilities (camera, terminal, filesystem, local models) and requests route to the device that has them
- Agent-to-agent structured task channel

## Explicitly not in the first version

- Full Notion-style editor
- Complex team administration
- AI summarization
- Automatic command execution
- Bluetooth-only communication
- UWB positioning
- Invisible optical transfer
- Large-scale mesh routing
- Native applications for every platform
- Permanent file storage
- Social collaboration / public note publishing
