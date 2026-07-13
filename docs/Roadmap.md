# ScreenMesh Roadmap

The core interaction to validate:

> Can a user move temporary information across devices faster and more naturally than sending it to themselves?

## Phase 0 — Scaffold ✅

- Monorepo, shared types, adapter interfaces, docs.

## Phase 1 — MVP: QR-bootstrapped handoff (in progress)

**Pairing & identity**
- [x] Accountless device identity (Ed25519, generated locally, never leaves the device)
- [x] Workspace creation + QR / join-link pairing (single-use, expiring tokens; owner-minted)
- [x] Workspace expiry (optional TTL at creation; relay refuses expired workspaces; clients clean up)
- [x] Device revocation (owner-only; relay access cut immediately, roster pruned everywhere — cryptographic re-keying still pending, see Security)

**Objects**
- [x] Text, links, code snippets
- [x] Images and small files (≤ 5 MB, base64 in encrypted envelopes; inline image preview + download)
- [ ] Checklists; chunked transfer for larger files (wants WebRTC)

**Sync**
- [x] IndexedDB local storage (Dexie)
- [x] Real-time relay sync (authenticated WebSocket, Ed25519 challenge)
- [x] Offline queues on both sides: client outbox drains on reconnect; relay store-and-forward for offline recipients
- [ ] WebRTC direct transfer (signaling endpoint stubbed)
- [ ] CRDT editing (Yjs) for concurrent object edits

**Device interactions**
- [x] Device dashboard with live presence; device inbox
- [x] Send to one, several, or all devices (offline recipients get it on return)
- [x] Delivery status lifecycle: queued → sending → delivered → opened
- [x] Leave workspace (local cleanup; also triggered by revocation/expiry)
- [ ] Continue-on-device

**Security**
- [x] End-to-end encrypted envelopes (AES-GCM workspace key + Ed25519 signatures)
- [x] Replay protection: message-ID dedupe, sequence numbers, envelope expiry
- [ ] Workspace key rotation; revocation-driven re-keying

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
