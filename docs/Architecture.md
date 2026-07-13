# ScreenMesh Architecture

ScreenMesh is a **local-first, transport-independent device handoff layer**. This document describes the four architectural layers, the data model, how synchronization and delivery work, and how the codebase maps onto the design.

Source material: [IDEA.md](../IDEA.md) (product concept), [Techncial.md](../Techncial.md) (connectivity research), [FUTURE.md](../FUTURE.md) (secure-channel vision).

---

## 1. Design principles

1. **Device-first, not document-first.** The primary verb is *"send this to that screen"*, not *"save this to a folder"*. Every device is an addressable surface with an identity and an inbox.
2. **Local-first, not cloud-first.** Every device keeps its own copy of workspace data in IndexedDB. The server is never the primary database; it is a relay and a store-and-forward queue for ciphertext.
3. **Transport-independent.** The application layer emits operations; it never knows (or cares) whether they traveled over WebRTC, a WebSocket relay, or a QR frame. Transports are interchangeable adapters behind a single interface.
4. **Temporary by default.** Objects and workspaces can expire. ScreenMesh is optimized for OTPs, links, commands, screenshots, and debug logs — not permanent archives.
5. **Eventually deliverable.** When no route exists, encrypted bundles wait in a local outbox and move when a route (or a trusted carrier device) appears.
6. **End-to-end encrypted.** Payloads are encrypted on the sending device and decrypted only on the recipient. Relays and carriers see ciphertext only. See [Security.md](Security.md).

---

## 2. The four layers

```text
┌───────────────────────────────────────┐
│ Layer 4: User interface               │
│ Notes, clipboard, files, device inbox │  apps/web
├───────────────────────────────────────┤
│ Layer 3: Shared state                 │
│ CRDT, local database, operation log   │  packages/sync, packages/storage
├───────────────────────────────────────┤
│ Layer 2: Routing and delivery         │
│ Discovery, queueing, acknowledgements │  packages/sync (delivery), packages/crypto
├───────────────────────────────────────┤
│ Layer 1: Transport adapters           │
│ WebRTC, WebSocket, QR, Nearby, LAN    │  packages/transport
└───────────────────────────────────────┘
```

### Layer 1 — Transport adapters

Every transport implements the same interface (`packages/transport/src/transport.ts`):

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

Transports carry **opaque bytes** — always ciphertext, never plaintext. The MVP ships three adapters (WebRTC, WebSocket relay, QR); the interface is deliberately shaped like the WICG Local Peer-to-Peer API proposal so a native browser implementation can slot in later. See [Transports.md](Transports.md) for the full adapter catalog and negotiation rules.

### Layer 2 — Routing and delivery

This layer decides *how* an encrypted operation reaches its destination:

1. **Transport negotiation.** Priority order: direct local peer connection → WebRTC P2P → internet relay → native nearby → QR/file transfer → queue until a route appears.
2. **Delivery queue.** Every outgoing object gets a `Delivery` record with a visible lifecycle:

   ```text
   Created → Queued → Sending → Delivered → Opened → Acknowledged
                                        ↘ Expired / Failed
   ```

3. **Acknowledgements.** The recipient acknowledges receipt (and, separately, opening) so the sender can display accurate status.
4. **Store–carry–forward.** The core differentiator. When the destination is unreachable, the encrypted `DeliveryBundle` stays in the outbox. Any trusted device the sender later syncs with may *carry* the bundle and hand it to the destination when they meet:

   ```text
   Phone A → Laptop B: send note
   Laptop B is offline.
   Phone A meets Tablet C → Tablet C accepts the encrypted bundle.
   Later Tablet C encounters Laptop B → Laptop B receives the note.
   ```

   Tablet C cannot read the note; it only carries ciphertext. Bundles carry a `hopLimit` and `expiresAt` so they cannot circulate forever:

   ```ts
   interface DeliveryBundle {
     bundleId: string;
     sourceDeviceId: string;
     destinationDeviceId: string;
     workspaceId: string;
     encryptedPayload: Uint8Array;
     createdAt: number;
     expiresAt: number;
     hopLimit: number;
     signature: Uint8Array;
   }
   ```

### Layer 3 — Shared state

**Operation log.** Instead of shipping whole workspaces, every change is an operation:

```json
{
  "operationId": "op_18291",
  "deviceId": "device_phone_1",
  "workspaceId": "workspace_72",
  "type": "CREATE_OBJECT",
  "objectId": "object_991",
  "timestamp": 1783871400,
  "payload": { "objectType": "text", "content": "Run pnpm dev before starting the worker" }
}
```

Operation types: `CREATE_OBJECT`, `UPDATE_OBJECT`, `DELETE_OBJECT`, `SEND_TO_DEVICE`, `MARK_DELIVERED`, `MARK_OPENED`, `PIN_OBJECT`, `MOVE_OBJECT`, `ADD_ATTACHMENT`, `REVOKE_DEVICE`. Devices exchange only the operations they are missing (delta sync keyed by per-device sequence numbers).

**CRDT merge.** Two devices may edit the same note while disconnected (phone edits the title, laptop edits the body). Rich object content is backed by **Yjs** documents so concurrent edits merge rather than overwrite; the operation log handles object lifecycle while Yjs handles intra-object content. State converges on every device once operations are exchanged.

**Local persistence** (`packages/storage`, IndexedDB via Dexie):

```text
devices        — paired device records, public keys, trust status
workspaces     — workspace membership and keys metadata
objects        — decrypted object cache for this device
operations     — append-only operation log
deliveries     — delivery records and status
outbox         — pending encrypted bundles awaiting a route
inbox          — received objects not yet acted on
carried        — encrypted bundles this device is carrying for others
```

### Layer 4 — User interface

A React PWA (`apps/web`). Key surfaces:

- **Device dashboard** — every paired device with online status, last seen, active transport, pending deliveries, and role (`input` / `editor` / `display` / `relay`).
- **Device inbox** — received objects with actions: open, copy, save, forward, convert, delete, pin.
- **Send-to-device selector** — one device, several, all, or *deliver when device returns*; per-send options like *expire after 1 hour*, *delete after opening*, *require confirmation*.
- **Shared scratchpad** — a temporary board of cards (text, code, links, images, files, checklists) all connected devices contribute to.
- **Pairing screen** — displays/scans the QR code, shows workspace expiry.
- **Sync status** — always-visible local-first indicators: `Saved locally · 4 operations waiting to sync`.

---

## 3. Data model

Canonical definitions live in `packages/protocol/src/types.ts`.

```ts
interface Device {
  id: string;
  name: string;
  publicKey: string;
  type: "phone" | "laptop" | "tablet" | "display" | "desktop";
  role: "input" | "editor" | "display" | "relay";
  lastSeenAt: number;
  status: "online" | "offline";
  trusted: boolean;
}

interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  expiresAt?: number;
  ownerDeviceId: string;
  memberDeviceIds: string[];
  mode: "personal" | "temporary" | "shared";
}

interface MeshObject {
  id: string;
  workspaceId: string;
  type: "text" | "link" | "code" | "image" | "file" | "checklist";
  content: unknown;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

interface Delivery {
  id: string;
  objectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  status: "queued" | "sending" | "delivered" | "opened" | "expired" | "failed";
  createdAt: number;
  deliveredAt?: number;
  openedAt?: number;
}
```

Every message on the wire is wrapped in a `SecureEnvelope` (see [Security.md](Security.md)) regardless of transport.

---

## 4. End-to-end data flow

Sending a URL from phone to laptop:

```text
 1. UI: user taps "Send to Nidhi's Laptop" on a link object.
 2. sync: CREATE_OBJECT + SEND_TO_DEVICE operations appended to local oplog,
          persisted to IndexedDB, Delivery record created (status: queued).
 3. crypto: operations serialized, encrypted with the workspace/session key,
            wrapped in a signed SecureEnvelope addressed to the laptop.
 4. routing: transport negotiation — is the laptop reachable?
      ├─ WebRTC data channel open?        → send directly        (Instant mode)
      ├─ Relay reachable + laptop online? → send via relay       (Instant mode)
      ├─ Devices physically nearby?       → local/nearby adapter (Nearby mode)
      └─ No route?                        → bundle stays in outbox (Eventual mode)
 5. laptop: envelope verified (signature, workspace, sequence number, replay
            checks) → decrypted → operations applied to local oplog & CRDT →
            object appears in inbox → acknowledgement sent back.
 6. phone: Delivery status advances (delivered → opened) as acks arrive.
```

The server, when involved at all, only ever handles step 4's ciphertext.

---

## 5. Server role (`apps/server`)

Deliberately minimal — the system must degrade gracefully without it:

| Responsibility | Notes |
|---|---|
| WebSocket signaling | Exchanging WebRTC offers/answers/ICE candidates between paired devices |
| Encrypted relay | Forwarding `SecureEnvelope` ciphertext when P2P fails |
| Store-and-forward queue | Holding ciphertext bundles for offline devices until they reconnect |
| Presence | Best-effort online/offline hints for the device dashboard |

The server **cannot** read notes, files, clipboard data, or commands. It does see metadata (device IDs, message sizes, timing, IPs) — this is documented honestly in [Security.md](Security.md). MVP runs on Fastify with in-memory queues; PostgreSQL/Redis/S3-compatible storage and coturn (TURN) arrive when persistence and NAT traversal demand them.

---

## 6. Package map

| Package | Responsibility | Depends on |
|---|---|---|
| `@screenmesh/protocol` | Types, envelope/operation/bundle schemas, constants | — |
| `@screenmesh/crypto` | Device identity (Ed25519), key agreement (X25519), payload encryption (AES-GCM), pairing payloads | protocol |
| `@screenmesh/transport` | `MeshTransport` interface, WebRTC / WebSocket / QR adapters, negotiation | protocol |
| `@screenmesh/storage` | Dexie schemas and persistence for oplog, outbox, inbox, devices | protocol |
| `@screenmesh/sync` | Operation log, CRDT (Yjs) integration, delivery lifecycle, store–carry–forward | protocol, crypto, storage, transport |
| `@screenmesh/web` | React PWA | all packages |
| `@screenmesh/server` | Fastify signaling + relay | protocol |

Dependency rule: packages may only depend downward in this table. `protocol` has zero dependencies; nothing imports from `apps/`.

---

## 7. Beyond the MVP: the device bus

The notes/scratchpad interface is the first visible application. Underneath it, the layers above amount to **identity, pairing, encryption, discovery, transport negotiation, reliable delivery, offline queueing** — a secure, local-first communication fabric for a user's devices. Once that exists, the same channel can carry:

- **Secure file drop** — files between trusted devices, no plaintext cloud hop.
- **Temporary clipboard tunnel** — share the clipboard for five minutes, then erase it.
- **Developer command channel** — send `pnpm run integration-test` from phone to laptop, executed only after explicit approval on the receiving device.
- **Agent-to-agent tasks** — structured tasks routed between local AI agents on different devices.
- **Capability routing** — devices expose selected capabilities (phone: camera, GPS; laptop: terminal, filesystem, local models) and ScreenMesh routes requests to the device that has them.

That trajectory — from shared scratchpad to **secure personal device bus** — is what the architecture is shaped for. See [Roadmap.md](Roadmap.md).
