# Product Concept: ScreenMesh

## 1. What Is ScreenMesh?

**ScreenMesh is a local-first cross-device workspace that moves notes, links, screenshots, files, clipboard items, and commands between nearby devices without depending on a single connection method.**

A user opens ScreenMesh on a laptop, opens it on a phone, pairs the two with a QR code (or a nearby BLE/NFC tap on Android), and from then on:

1. Anything created on one device can be sent to another, to several, or to everyone in the workspace.
2. Editing continues even when a device disconnects.
3. Changes reconcile automatically the moment devices reconnect.
4. If no device is reachable right now, the content waits — encrypted, queued — until one is.

It is not:

> A collaborative notes application using Bluetooth.

It is:

> A personal network connecting a user's screens, where content moves through whichever route is currently available.

---

# 2. Core Product Definition

ScreenMesh treats every connected device as a surface inside one personal workspace:

```text
Nidhi's Phone
Nidhi's Laptop
Lab Desktop
Tablet
Meeting Room Screen
```

Each device carries:

* An identity (Ed25519 signing + X25519 key-agreement keys, generated locally — no account, no signup)
* A local inbox and outbox
* A list of paired devices with live presence
* A synchronized copy of the workspace
* A record of pending and delivered objects

An object can be sent to one specific device, several, everyone in the workspace, or "whichever device currently has the capability I need" — and it can target a device that's offline right now, arriving the moment that device comes back.

```ts
type MeshObject =
  | TextNote
  | ClipboardItem
  | Link
  | Image
  | File
  | Checklist
  | CodeSnippet
  | Command
  | AgentTask;
```

---

# 3. The Problem

People work across several devices — phone, personal laptop, work laptop, tablet, a shared lab machine, a meeting-room display — but moving temporary information between them is still fragmented. The usual workarounds:

* Messaging yourself on WhatsApp or Telegram
* Emailing yourself a link
* Uploading a file to Drive just to redownload it elsewhere
* Copying through Slack
* Manually pairing over Bluetooth
* Logging a personal account into a shared machine
* Screenshotting and re-uploading

Each of these carries a real cost:

**Too many steps.** Moving a URL from phone to laptop means switching apps, finding the right chat, sending, switching apps again, and copying it back out.

**Account dependency.** Most cross-device tools require the same cloud account everywhere — unworkable on shared desktops, labs, public computers, meeting rooms, or a client's machine.

**Internet dependency.** Most of these tools stop working the moment internet access is weak, a device is briefly offline, two devices sit on different networks, or a firewall blocks the connection.

**No device-level addressing.** Notes apps organize around documents, not devices. There's no natural way to say "send this to my laptop" or "queue this file for the desktop when it's back online."

**Poor fit for temporary information.** OTPs, links, error messages, terminal commands, screenshots, API responses, debug logs — none of these deserve a permanent note or a full storage system. They need to move once and then, ideally, disappear.

---

# 4. Why This Needs to Exist

Continuity exists inside single ecosystems — Apple devices, or a single OEM's Android lineup — but there is no open, cross-platform handoff layer that works across Android, Windows, Linux, macOS, browser sessions, and shared or temporary machines.

ScreenMesh closes that gap by separating the application from the connection method underneath it. It never asks "are these devices on Bluetooth?" — it asks "what's the best available route between these two devices right now?" That route might be local Wi-Fi, WebRTC, a relay, Bluetooth LE, Wi-Fi Direct, NFC, near-ultrasonic audio, or a store-and-forward hop through a third device — the application layer never needs to know which.

---

# 5. Product Experience

## Phone to laptop

The laptop shows a pairing QR. The phone scans it; the devices pair. The user copies a URL on the phone and taps **Send to Nidhi's Laptop** — it appears instantly, ready to open, copy, pin, delete, or forward.

## Laptop is offline

The phone shows **Queued for Nidhi's Laptop — waiting for connection**. The note sits encrypted in the phone's local outbox. The moment the laptop reconnects, it arrives — no retry, no re-send, nothing the user has to do.

## Shared lab desktop

The lab machine shows a temporary pairing QR; the user scans it and a short-lived workspace spins up. They send a GitHub URL, a terminal command, a config file. The lab desktop never touches the user's personal account, and the workspace can expire automatically at the end of the session.

## Multi-screen workspace

Phone, laptop, tablet, and a projector all pair into one workspace. The phone drives; the laptop edits; the tablet holds reference material; the projector displays selected cards. An object can move phone → laptop → projector as naturally as dragging it across a desk.

---

# 6. How It Works

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
│ WebRTC, WebSocket, BLE, Wi-Fi Direct, │
│ NFC, acoustic, QR                     │
└───────────────────────────────────────┘
```

## Local-first storage

Every device keeps its own copy of the workspace it belongs to (IndexedDB via Dexie in the browser, an equivalent local snapshot on Android). The server is never the primary datastore — a device can create, edit, and queue objects entirely offline.

## Operation log

Rather than syncing whole documents, ScreenMesh records operations:

```json
{
  "operationId": "op_18291",
  "deviceId": "device_phone_1",
  "workspaceId": "workspace_72",
  "type": "CREATE_OBJECT",
  "objectId": "object_991",
  "timestamp": 1783871400,
  "payload": {
    "objectType": "text",
    "content": "Run pnpm dev before starting the worker"
  }
}
```

Devices exchange only the operations they're missing:

```text
CREATE_OBJECT      UPDATE_OBJECT     DELETE_OBJECT
SEND_TO_DEVICE     MARK_DELIVERED    MARK_OPENED
REJECT_OBJECT      CARRY_BUNDLE      REVOKE_DEVICE
CONTINUE_ON_DEVICE
```

## Conflict-free synchronization

Two devices editing the same object while disconnected merge rather than overwrite. Editable text/code/link objects use Yjs (a CRDT); everything else uses last-write-wins, which is sufficient for objects that are sent and received rather than co-edited.

## Transport negotiation

The application layer never knows or cares which transport actually carried a message — every adapter implements the same interface:

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

A send prefers a direct WebRTC connection when both devices are online, falls back to the relay when it isn't, and — with no route at all — queues locally for delivery the moment one appears.

---

# 7. Connection Methods

**WebRTC** — direct browser-to-browser data channels for notes, clipboard items, images, files, and presence, whenever both devices can reach each other.

**WebSocket relay** — the fallback when direct peer-to-peer isn't possible: different networks, NAT, a reconnecting device. The relay authenticates every device with an Ed25519 challenge and forwards ciphertext only — it never has the keys to read what it's carrying.

**QR pairing** — the trust ceremony. A single scan carries a workspace ID, a device identity, a single-use pairing token, and the workspace's key material. No accounts, no typed codes, works on nearly every phone.

**Nearby transports (Android)** — Bluetooth LE (a real GATT peripheral+central pair, not a wrapper around a third-party SDK), Wi-Fi Direct (peer discovery plus a raw TCP socket for higher-throughput transfer), NFC tap-to-pair, and a near-ultrasonic acoustic transport for when there's no radio available at all. BLE and NFC double as pairing bootstraps — both just move the same pairing-code string a QR carries.

**Store–carry–forward** — the most distinctive piece. When the destination is offline, the sender's device holds an encrypted delivery bundle. Any other online, trusted device that later encounters the real destination can carry that bundle forward and hand it off — without ever being able to decrypt it itself, since the payload is only ever readable by the true destination's own Double Ratchet session.

```text
Phone sends a note to Laptop.
Laptop is offline.
Phone syncs with Tablet — Tablet holds the encrypted bundle.
Tablet later connects to Laptop.
Laptop receives and decrypts the note. Tablet never could.
```

This turns a set of devices that are rarely all online at once into something that still behaves like one connected personal network.

---

# 8. Core Features

**Device pairing** — QR code, BLE, NFC, all sharing one pairing-code format and one trust ceremony.

**Device dashboard** — live presence, transport in use, last-seen time, pending deliveries, per-device trust status.

**Device inbox** — every object a device has received, actionable in place: open, copy, save, forward, convert, pin, delete.

**Send to device** — target one device, several, or all, with delivery options: deliver on reconnect, expire after a duration, delete after opening, require explicit confirmation before the recipient can act on it.

**Shared scratchpad** — a card-based board rather than a long document, better suited to quick cross-device work than a traditional notes editor.

**Universal clipboard** — copy on one device, explicitly send it, paste on another. User-triggered rather than continuously synced, since browser clipboard access is permission-gated.

**Continue on another device** — hand an object off and have the target device open it with the cursor exactly where it was left.

**Offline editing** — full read/write/queue capability with no connection at all, with a clear local status: *Saved locally — 4 operations waiting to sync.*

**Delivery lifecycle** — every send moves through `queued → sending → delivered → opened`, visible to the sender in real time.

**Temporary workspaces** — short-lived rooms with an expiry, useful for hackathons, classrooms, labs, and shared machines. They vanish on their own; no cleanup, no lingering account.

**Device roles** — a phone as input, a laptop as editor, a projector as display-only, a tablet as a relay/carrier, a lab machine as a restricted shared terminal.

**Privacy controls** — per-workspace policy (local-only, direct-preferred, relay-allowed, trusted-devices-only), plus instant device revocation that cuts relay access immediately.

**Expiring objects** — content that disappears after a duration, after being opened, when the workspace ends, or at a fixed time — right for OTPs, debug output, and anything sensitive that shouldn't linger.

**File and screenshot handoff** — photos, screenshots, PDFs, small files, and logs move phone-to-laptop directly; anything larger than a normal envelope automatically chunks into a sequence of smaller, independently-deliverable pieces.

**Command objects** — a command received on another device is a card with explicit actions (copy, open terminal, mark executed), never auto-run. A trusted desktop agent can go one step further and execute a command, but only behind an interactive approval prompt.

---

# 9. Developer-Focused Use

The first audience is developers working across several devices:

* **Mobile testing** — screenshot and logs from a test phone straight to the laptop debugging it.
* **Remote commands** — a command found while reading docs on a phone, thrown to the laptop's terminal.
* **Shared debugging** — phone, tablet, and laptop all contributing logs and screenshots to one workspace.
* **Lab environments** — repos, commands, and config sent to a shared machine without signing anything into it.
* **Demo sessions** — a phone driving what a presentation screen shows.

---

# 10. Scope

## In scope

**Pairing** — temporary or persistent workspaces, QR/BLE/NFC pairing, accountless device identity, instant revocation.

**Objects** — text, links, code, images, small files (with chunking for larger ones), checklists.

**Sync** — local-first storage, real-time relay sync, WebRTC direct transfer, an offline operation queue, reconnection and reconciliation, CRDT-merged editing.

**Device interactions** — device list, inbox, send-to-device/all, continue-on-device, delivery status.

**Security** — end-to-end encryption with per-message forward secrecy, signed and replay-protected messages, instant device revocation.

## Deliberately out of scope

* A full Notion-style editor
* Complex team administration
* AI summarization
* Automatic (unapproved) command execution
* Bluetooth-only communication
* UWB positioning
* Invisible optical transfer
* Large-scale mesh routing
* Permanent file storage
* Public note publishing or social collaboration

These would all distract from the one question that matters:

> Can a user move temporary information across devices faster and more naturally than sending it to themselves?

---

# 11. Technical Stack

## Frontend

```text
React · TypeScript · Vite
Service worker · Web App Manifest
IndexedDB via Dexie
Yjs
WebRTC · WebSocket
```

## Backend

```text
Fastify
@fastify/websocket for relay signaling
```

Deliberately lean: no PostgreSQL, no Redis, no S3-compatible storage. The server was never meant to be the primary datastore — workspace and device state live in memory, and files never rest on the server in plaintext or otherwise, since they travel end-to-end encrypted the same way any other object does.

## Native Android

```text
Kotlin · BouncyCastle (Ed25519/X25519/HKDF)
javax.crypto (AES-GCM) · OkHttp
android.bluetooth · WifiP2pManager · NFC (NDEF)
```

A hand-ported mirror of the same protocol, crypto, sync, and transport layers — not a thin wrapper around the web app — so a phone speaks the exact same wire protocol as the browser and desktop.

## Local persistence

```text
IndexedDB (Dexie) — web, agent
SharedPreferences-backed snapshot — Android
Yjs document state · pending delivery queue · encrypted object cache
```

## Cryptography

```text
Web Crypto API (browser/agent) · BouncyCastle (Android)
Ed25519 device identity and signatures
X25519 key agreement
AES-GCM payload encryption
Per-pair Double Ratchet sessions for forward secrecy
```

---

# 12. Data Model

## Device

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
```

## Workspace

```ts
interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  expiresAt?: number;
  ownerDeviceId: string;
  memberDeviceIds: string[];
  mode: "personal" | "temporary" | "shared";
}
```

## Object

```ts
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
```

## Delivery

```ts
interface Delivery {
  id: string;
  objectId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  status:
    | "queued"
    | "sending"
    | "delivered"
    | "opened"
    | "expired"
    | "failed";
  createdAt: number;
  deliveredAt?: number;
  openedAt?: number;
}
```

`type`/`role`/`status` fields are deliberately plain strings rather than closed enums, so the TypeScript and native ports can stay in sync without an enum-to-string mapping that could quietly drift between the two.

---

# 13. Product Differentiation

**Device-first, not document-first.** Information is sent to a screen, not merely filed into a shared folder.

**Local-first, not cloud-first.** Every device stays useful when the internet disappears.

**Transport-independent.** WebRTC, a relay, BLE, Wi-Fi Direct, NFC, or sound — whichever is available, chosen automatically.

**Temporary by default.** Objects and workspaces can expire instead of accumulating as permanent clutter.

**Eventually deliverable.** Content can wait, encrypted, and still find its destination later — even by riding along on another device that happens to encounter it first.

---

# 14. Product Positioning

**One line:**
> Move notes, links, screenshots, files, and clipboard items between your devices — even when they're temporarily disconnected.

**Technical:**
> A local-first, transport-independent device handoff layer that synchronizes end-to-end encrypted objects across browsers, phones, laptops, and shared screens.

**Developer pitch:**
> A cross-device scratchpad for developers. Send commands, logs, links, screenshots, and files between phones, laptops, test devices, and lab machines — without emailing or messaging yourself.

**Longer vision:**
> Every screen around a user becomes part of one programmable personal workspace. Information isn't trapped inside a specific app or device — it moves to whichever screen needs it, through whatever route is currently open.
