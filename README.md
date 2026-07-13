# ScreenMesh

> **A local-first device handoff fabric that moves objects between your screens through any available connection.**

ScreenMesh lets you move notes, links, screenshots, files, clipboard items, and commands between your devices — phone, laptop, tablet, lab desktop, meeting-room display — **even when the devices are temporarily disconnected**. It is not a notes app with Bluetooth; it is a personal network connecting your screens, where content moves through whichever transport is currently available and stays queued when none exists.

```text
┌───────────────────────────────────────┐
│ User interface                        │
│ Notes, clipboard, files, device inbox │
├───────────────────────────────────────┤
│ Shared state                          │
│ CRDT, local database, operation log   │
├───────────────────────────────────────┤
│ Routing and delivery                  │
│ Discovery, queueing, acknowledgements │
├───────────────────────────────────────┤
│ Transport adapters                    │
│ WebRTC, WebSocket, QR, Nearby, LAN    │
└───────────────────────────────────────┘
```

---

## The problem

People work across many devices, but moving *temporary* information between them is still fragmented: WhatsApp messages to yourself, emailing links, uploading files to Drive, logging into personal accounts on shared lab machines. These workflows suffer from:

- **Too many steps** — moving a URL from phone to laptop shouldn't require a chat app.
- **Account dependency** — shared desktops, labs, and meeting rooms shouldn't need your cloud login.
- **Internet dependency** — most tools stop working when one device disconnects or networks are restricted.
- **No device-level addressing** — existing tools organize around documents, not *"send this to my laptop"*.
- **Poor support for temporary information** — OTPs, error messages, commands, and debug logs don't need a permanent notes system.

## The idea

ScreenMesh treats every connected device as a surface inside one personal workspace. Each device has an identity, a local inbox/outbox, a list of paired devices, and a synchronized workspace. The system never asks *"are these devices connected via Bluetooth?"* — it asks:

> **What is the best available route between these devices right now?**

That route could be local Wi-Fi, WebRTC, a WebSocket relay, Nearby Connections, a QR transfer — or *no route at all right now*, in which case the encrypted object waits in the outbox and is delivered when a route appears (possibly carried by another trusted device).

### Three operating modes

| Mode | Condition | Path |
|---|---|---|
| **Instant** | Devices share internet or a network | WebRTC direct → WebSocket relay fallback |
| **Nearby** | No internet, devices physically close | QR/NFC pairing → Nearby/Wi-Fi transfer |
| **Eventual** | No usable route exists | Encrypted bundle → local outbox → later encounter or trusted relay |

### Security model

ScreenMesh is an **end-to-end encrypted application-layer tunnel between trusted devices** — not a VPN, not a general TCP tunnel. Every device generates its own keypair; pairing (QR code) exchanges public keys and an ephemeral pairing token. Payloads are encrypted on the sender and decrypted on the recipient — relays only ever see ciphertext. Messages are signed, sequence-numbered, and expiring to prevent tampering and replay. See [docs/Security.md](docs/Security.md).

---

## Core features (MVP)

- **QR device pairing** — accountless, cross-platform, explicitly authorized. Temporary workspaces with expiry.
- **Device dashboard & inbox** — see every paired device, its status and transport; every device has an inbox of received objects.
- **Send to device** — text, links, code snippets, images, small files, checklists. Send to one device, several, all, or a currently-offline device.
- **Delivery lifecycle** — `Created → Queued → Sending → Delivered → Opened → Acknowledged / Expired / Failed`, visible to the user.
- **Offline-first** — IndexedDB local storage, operation log sync, CRDT merge (Yjs) on reconnect.
- **Expiring objects** — after 10 minutes, after opening, when the workspace ends. Temporary by default.
- **Command objects** — commands arrive as cards with *Copy / Open terminal / Save to history* actions. **Never auto-executed** in the MVP.
- **Client-side encryption** — signed device messages, rotating workspace keys, device revocation.

Explicit non-goals for v1: full Notion-style editor, AI features, automatic command execution, native apps for every platform, permanent file storage, social collaboration. See [docs/Roadmap.md](docs/Roadmap.md).

## First target users: developers

Send a command from documentation on your phone straight to your laptop. Throw a screenshot and device logs from a test phone to your editor. Pair with a lab machine for one session — send it a repo URL, a config file, a snippet — without signing into anything personal, and let the workspace expire when you leave.

---

## Repository layout

```text
ScreenMesh/
├── apps/
│   ├── web/            # PWA — React + TypeScript + Vite, service worker, IndexedDB
│   └── server/         # Fastify relay — WebSocket signaling + encrypted store-and-forward
├── packages/
│   ├── protocol/       # Shared types: objects, envelopes, operations, delivery bundles
│   ├── crypto/         # Device identity, pairing, payload encryption (Web Crypto)
│   ├── transport/      # MeshTransport interface + WebRTC / WebSocket / QR adapters
│   ├── sync/           # Operation log, CRDT integration, delivery & routing, outbox
│   └── storage/        # Dexie/IndexedDB persistence layer
├── docs/
│   ├── Architecture.md # Layered architecture, data flow, sync & delivery design
│   ├── Security.md     # Identity, pairing, E2EE, replay protection, threat model
│   ├── Transports.md   # Transport adapters, negotiation, future transports
│   └── Roadmap.md      # MVP scope, phases, explicit non-goals
├── IDEA.md             # Original product concept
├── Techncial.md        # Transport & connectivity research
└── FUTURE.md           # Secure-channel vision: device bus, capability routing
```

## Getting started

Requirements: **Node.js ≥ 20** and **pnpm ≥ 9**.

```bash
pnpm install

# Run the signaling/relay server (ws://localhost:8787)
pnpm dev:server

# Run the PWA (http://localhost:5173)
pnpm dev:web

# Type-check everything
pnpm typecheck

# End-to-end smoke tests (relay must be running)
pnpm smoke
```

**Trying it out with two "devices":** open `http://localhost:5173` in one browser window (create the workspace) and `http://localhost:5173/?device=2` in another (the `device` query parameter gives it a separate local identity/database). Copy the join link from the first window's pairing panel into the second. To pair a real phone, run `pnpm dev:web -- --host` and open the LAN URL so the QR code points at an address the phone can reach.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React, TypeScript, Vite, PWA (service worker + manifest) |
| Local persistence | IndexedDB via Dexie, Yjs document updates, encrypted object cache |
| Sync | Yjs (CRDT), custom operation log, offline delivery queue |
| Transports | WebRTC data channels, WebSocket relay, QR pairing/transfer |
| Backend | Fastify (WebSocket signaling + relay), later PostgreSQL/Redis/coturn |
| Crypto | Web Crypto API — Ed25519 signatures, X25519 key agreement, AES-GCM payloads |

## Documentation

- [Architecture](docs/Architecture.md) — the four layers, operation log, CRDT sync, store–carry–forward delivery
- [Security](docs/Security.md) — device identity, pairing, envelope format, replay protection, what ScreenMesh is *not*
- [Transports](docs/Transports.md) — adapter interface, negotiation priority, current and future transports
- [Roadmap](docs/Roadmap.md) — MVP scope and the phased path to a secure personal device bus

## Positioning

> **One-liner:** ScreenMesh lets you move notes, links, screenshots, files, and clipboard items between your devices, even when the devices are temporarily disconnected.
>
> **Technical:** A local-first, transport-independent device handoff layer that synchronizes encrypted objects across browsers, phones, laptops, and shared screens.
>
> **Vision:** Every screen around you becomes part of one programmable personal workspace. Information moves to the screen where it is needed, through the best available route — a secure, local-first communication fabric for a user's devices.
