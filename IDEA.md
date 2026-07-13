# Product Concept: ScreenMesh

## 1. What Are We Building?

**ScreenMesh is a local-first cross-device workspace that lets users move notes, links, screenshots, files, clipboard items, and commands between nearby devices without depending on a single connection method.**

A user should be able to:

1. Open ScreenMesh on a laptop.
2. Open it on a phone.
3. Pair the devices using a QR code, nearby discovery, or another available method.
4. Create something on one device.
5. Send it to another device or continue editing it there.
6. Keep working even when one device disconnects.
7. Automatically synchronize changes when the devices reconnect.

The product starts as a PWA but is designed as a broader cross-device communication layer.

It is not simply:

> A collaborative notes application using Bluetooth.

It is:

> A personal network connecting the user’s screens, where content can move through any available transport.

---

# 2. Core Product Definition

ScreenMesh treats every connected device as a surface inside one personal workspace.

For example:

```text
Nidhi’s Phone
Nidhi’s Laptop
Lab Desktop
Tablet
Meeting Room Screen
```

Each device has:

* An identity
* A local inbox
* A local outbox
* A list of paired devices
* A synchronized workspace
* A record of pending and delivered objects

The user can create an object on one device and send it to:

* One specific device
* Multiple devices
* Every device in a workspace
* The next available device
* A currently offline device

Objects may include:

```ts
type MeshObject =
  | TextNote
  | ClipboardItem
  | Link
  | Image
  | File
  | VoiceNote
  | Checklist
  | CodeSnippet
  | Command
  | Task;
```

---

# 3. What Problem Are We Solving?

People increasingly work across several devices:

* Phone
* Personal laptop
* Work laptop
* Tablet
* Secondary desktop
* Shared lab computer
* Smart display
* Projector or meeting-room screen

However, transferring temporary information between these devices is still unnecessarily fragmented.

Common workflows include:

* Sending yourself a WhatsApp message
* Emailing yourself a link
* Uploading a file to Google Drive
* Opening the same notes application everywhere
* Copying through Slack
* Creating a temporary Telegram message
* Pairing through Bluetooth manually
* Logging into personal accounts on shared machines
* Taking screenshots and re-uploading them elsewhere

These approaches create several problems:

### Too many steps

Moving a simple URL from a phone to a laptop can require opening another application, finding the correct chat, sending the URL, reopening the application on the laptop, and copying it again.

### Account dependency

Most cross-device tools require the user to sign into the same cloud account on every device.

This is undesirable for:

* Shared desktops
* Labs
* Public computers
* Meeting rooms
* Temporary workstations
* Client machines

### Internet dependency

Most applications stop working when:

* Internet access is weak
* One device temporarily disconnects
* Devices are on different networks
* Corporate firewalls block connections
* Users intentionally want local-only communication

### No device-level addressing

Existing notes tools organize information around documents.

They do not naturally support:

```text
Send this code snippet to my laptop.

Place this checklist on the lab screen.

Open this URL on the meeting room display.

Queue this file for the desktop when it comes online.
```

### Poor support for temporary information

Many cross-device transfers are not permanent documents.

They are temporary objects such as:

* OTPs
* Links
* Error messages
* Terminal commands
* Screenshots
* API responses
* Addresses
* Meeting notes
* Small files
* Debug logs

A full note-taking or storage system is excessive for these tasks.

---

# 4. Why Does This Need to Exist?

The operating-system ecosystem is fragmented.

Apple provides strong continuity inside Apple devices.

Android and Windows provide some cross-device features.

Individual manufacturers such as Samsung, Huawei, Xiaomi, and OPPO provide proprietary device ecosystems.

But there is no reliable, open, cross-platform handoff layer that works across:

* Android
* Windows
* Linux
* macOS
* Browser sessions
* Shared computers
* Temporary displays

ScreenMesh fills this gap by separating the application from the underlying connection method.

The product does not ask:

> Are these devices connected through Bluetooth?

It asks:

> What is the best available route between these devices right now?

That route could be:

* Local Wi-Fi
* WebRTC
* WebSocket relay
* Bluetooth through a native companion
* Wi-Fi Direct
* Nearby Connections
* QR transfer
* NFC pairing
* Optical transfer
* Store-and-forward synchronization

---

# 5. Main Product Experience

## Example 1: Phone to laptop

The user opens ScreenMesh on a laptop.

The laptop displays:

```text
Pair a device

[QR code]

Workspace expires in 24 hours
```

The user scans it using the phone.

The devices become paired.

The user copies a URL on the phone and selects:

```text
Send to Nidhi’s Laptop
```

The URL appears instantly on the laptop.

The user can:

* Open it
* Copy it
* Pin it
* Delete it
* Convert it into a note
* Send it to another device

---

## Example 2: Laptop is offline

The user sends a note to a laptop that is currently unavailable.

The phone displays:

```text
Queued for Nidhi’s Laptop
Waiting for connection
```

The note remains encrypted in the phone’s local outbox.

When the laptop reconnects, the note is delivered automatically.

---

## Example 3: Shared lab desktop

The lab desktop opens ScreenMesh and shows a temporary pairing QR.

The user scans it.

A short-lived workspace is created.

The user sends:

* A GitHub URL
* A terminal command
* A configuration file
* A code snippet

The lab desktop never receives access to the user’s full personal account.

The workspace can automatically expire after the session.

---

## Example 4: Multi-screen workspace

The user pairs:

* Phone
* Laptop
* Tablet
* Projector

The phone acts as the control device.

The laptop is the main editor.

The tablet displays reference material.

The projector displays selected cards.

The user can move an object between surfaces:

```text
Phone → Laptop → Projector
```

---

# 6. How Does ScreenMesh Work?

ScreenMesh has four technical layers.

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
│ WebRTC, WebSocket, QR, Nearby, LAN     │
└───────────────────────────────────────┘
```

---

## Layer 1: Local-first storage

Every device stores its own copy of the relevant workspace data.

The user can:

* Create notes offline
* Edit existing objects offline
* Queue transfers offline
* Read previously synchronized content offline

Data is stored locally using IndexedDB.

The server is not treated as the primary database for every interaction.

---

## Layer 2: Operation log

Instead of sending the entire workspace after every change, ScreenMesh records operations.

Example:

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

Other operation types include:

```text
CREATE_OBJECT
UPDATE_OBJECT
DELETE_OBJECT
SEND_TO_DEVICE
MARK_DELIVERED
MARK_OPENED
PIN_OBJECT
MOVE_OBJECT
ADD_ATTACHMENT
REVOKE_DEVICE
```

Devices exchange only the operations they are missing.

---

## Layer 3: Conflict-free synchronization

Two devices may edit the same note while disconnected.

For example:

```text
Phone changes the title.
Laptop changes the body.
```

When they reconnect, ScreenMesh should merge the changes rather than blindly overwriting one version.

A CRDT library such as Yjs can manage this synchronization.

The state eventually converges across all devices.

---

## Layer 4: Transport negotiation

ScreenMesh chooses the best available connection.

Example priority:

```text
1. Direct local peer connection
2. WebRTC peer-to-peer connection
3. Internet relay
4. Native nearby connection
5. QR or file transfer
6. Queue until a route becomes available
```

The application layer does not need to know whether an operation was delivered through WebRTC, WebSocket, or another adapter.

Each transport implements the same interface:

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

---

# 7. Connection Methods

## WebRTC

Used for direct browser-to-browser communication.

Best when:

* Both devices are online
* A direct peer connection can be established
* Low-latency transfer is needed

Used for:

* Notes
* Clipboard items
* Images
* Files
* Presence updates

---

## WebSocket relay

Used when direct peer-to-peer communication is unavailable.

The server temporarily forwards encrypted messages.

The server should not need access to plaintext user content.

Best when:

* Devices are on different networks
* Corporate NAT prevents direct connection
* One device is reconnecting
* Reliable delivery is more important than pure P2P

---

## QR pairing

QR is used to exchange:

* Workspace ID
* Device identity
* Public key
* Pairing secret
* Expiry
* Signaling information

QR pairing is ideal because it is:

* Cross-platform
* Easy to understand
* Accountless
* Explicitly authorized
* Available on almost every phone

---

## QR offline transfer

For small objects, ScreenMesh can encode encrypted data into one or more QR frames.

Useful when:

* There is no internet
* Devices cannot connect directly
* A small message must be transferred immediately

This should initially support:

* Text
* URLs
* Pairing credentials
* Small synchronization bundles

---

## Native nearby adapter

A later Android or desktop companion can provide access to:

* Google Nearby Connections
* Wi-Fi Direct
* Wi-Fi Aware
* Bluetooth Low Energy
* Local LAN discovery

The native application acts as a bridge while the PWA remains the primary interface.

---

## Store–carry–forward delivery

This is one of the main differentiators.

When the destination is unavailable, ScreenMesh stores the encrypted object.

Later, another trusted device can carry it.

Example:

```text
Phone sends note to Laptop.

Laptop is offline.

Phone synchronizes with Tablet.

Tablet later connects to Laptop.

Laptop receives the note.
```

The tablet does not need to read the note.

It only carries an encrypted bundle.

Each bundle includes:

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

This creates an intermittent personal network where information can move even without continuous connectivity.

---

# 8. Core Features

## A. Device pairing

Users can pair devices through:

* QR code
* Short pairing code
* Shared link
* Nearby discovery
* NFC in future
* Optical or acoustic pairing experiments

Pairing establishes trust between devices.

---

## B. Device dashboard

The user sees every paired device.

```text
Devices

● Nidhi’s Laptop
  Online · WebRTC

● Pixel Phone
  This device

○ Lab Desktop
  Offline · Last seen 2 hours ago

● Tablet
  Online · Local network
```

Each device shows:

* Online or offline status
* Last active time
* Available transport
* Pending deliveries
* Device role
* Trust status

---

## C. Device inbox

Every device has an inbox.

Example:

```text
Laptop Inbox

1. GitHub repository URL
2. Docker command
3. Screenshot from phone
4. API response
5. Pending checklist
```

Objects can be:

* Opened
* Copied
* Saved
* Forwarded
* Converted
* Deleted
* Pinned

---

## D. Send to device

Every object has a device selector.

```text
Send to:

✓ Nidhi’s Laptop
○ Tablet
○ Lab Desktop
○ All devices
```

The user can also set:

```text
Deliver when device returns
Expire after 1 hour
Delete after opening
Require confirmation
```

---

## E. Shared scratchpad

All connected devices can contribute to a temporary board.

The board contains cards rather than long documents.

Cards may be:

* Text
* Code
* Links
* Images
* Files
* Checklists
* Voice notes

This makes the product more suitable for quick cross-device work than a traditional notes editor.

---

## F. Universal clipboard

ScreenMesh can provide a controlled shared clipboard.

The user copies something on one device and explicitly shares it.

Examples:

```text
Copy on phone → Paste on laptop
Copy error on laptop → Open on tablet
Copy address on laptop → Open maps on phone
```

Initially, clipboard capture should be user-triggered because browser clipboard access is permission-restricted.

A browser extension or native companion can later provide deeper clipboard integration.

---

## G. Continue on another device

Every object can be handed off.

Example:

```text
Continue editing on:

Nidhi’s Laptop
```

The target device opens the exact object and places the cursor at the last editing position.

---

## H. Offline editing

The application works without internet.

The user can:

* Create notes
* Edit cards
* Queue deliveries
* Browse cached objects
* Export synchronization bundles

The system displays clear status:

```text
Saved locally
4 operations waiting to sync
```

---

## I. Delivery states

Each sent object has a clear lifecycle.

```text
Created
Queued
Sending
Delivered
Opened
Acknowledged
Expired
Failed
```

Example:

```text
Docker command
Delivered to Nidhi’s Laptop
Opened 20 seconds ago
```

---

## J. Temporary workspaces

Users can create temporary rooms.

```text
Workspace: Hackathon Table 4
Expires: In 6 hours
Members: 5 devices
```

Temporary workspaces are useful for:

* Hackathons
* Classrooms
* Meetings
* Labs
* Pair programming
* Events
* Workshops

They can expire automatically without leaving permanent accounts or data.

---

## K. Device roles

Each device can be assigned a role.

### Input device

Used for capturing text, images, and commands.

Typical device: phone.

### Editor

Used for detailed editing.

Typical device: laptop.

### Display

Used only for showing selected cards.

Typical device: projector or TV.

### Relay

Carries encrypted bundles between devices.

Typical device: tablet or personal server.

### Shared terminal

Receives temporary commands or files with restricted permissions.

Typical device: lab desktop.

---

## L. Privacy controls

Each workspace can be configured as:

```text
Local only
Direct connections preferred
Encrypted relay allowed
Trusted devices only
Temporary guests allowed
```

Users can revoke devices at any time.

Revocation prevents the device from receiving future workspace keys.

---

## M. Expiring objects

Temporary information should not remain forever.

Objects may expire:

```text
After 10 minutes
After 1 hour
After being opened
When workspace ends
At a specific time
Never
```

This is useful for:

* Temporary links
* OTPs
* Debug information
* Sensitive snippets
* Meeting-room content

---

## N. File and screenshot handoff

The phone can send:

* Camera photos
* Screenshots
* PDFs
* Small files
* Logs

The laptop can receive and download them immediately.

Large files may transfer directly peer-to-peer when possible.

---

## O. Command objects

Developer-focused commands can be treated differently from ordinary text.

Example:

```text
pnpm run dev
```

The laptop receives it as a command card with actions:

```text
Copy command
Open terminal
Save to history
Mark as executed
```

For security, ScreenMesh should not execute commands automatically during the MVP.

Later, a trusted desktop agent may support controlled execution.

---

# 9. Developer-Focused Initial Version

The first target users should be developers working across multiple devices.

## Common developer workflows

### Mobile testing

A developer sees an error on a test phone.

They send the screenshot and device logs directly to the laptop.

### Remote commands

A developer finds a command or configuration while reading documentation on the phone.

They throw it to the laptop.

### Shared debugging

A phone, tablet, and laptop contribute logs and screenshots to the same debugging workspace.

### Lab environments

A developer sends repositories, commands, and configuration snippets to a temporary lab computer without signing into personal messaging applications.

### Demo sessions

A phone controls what appears on a presentation screen.

---

# 10. MVP Scope

The MVP should prove the cross-device handoff experience.

## MVP features

### Authentication and pairing

* Temporary workspace creation
* QR pairing
* Device identity
* Device revocation
* Optional accountless session

### Objects

* Text
* Links
* Code snippets
* Images
* Small files
* Checklists

### Synchronization

* Local IndexedDB storage
* Real-time WebSocket synchronization
* WebRTC direct transfer
* Offline operation queue
* Reconnection and reconciliation
* Basic CRDT editing

### Device interactions

* Device list
* Device inbox
* Send to device
* Send to all
* Continue on device
* Delivery status

### Security

* Client-side workspace encryption
* Expiring workspace keys
* Signed device messages
* Device revocation

---

# 11. What Should Not Be in the First Version?

Avoid building these initially:

* Full Notion-style editor
* Complex team administration
* AI summarization
* Automatic command execution
* Bluetooth-only communication
* UWB positioning
* Invisible optical transfer
* Large-scale mesh routing
* Native applications for every platform
* Permanent file storage
* Social collaboration
* Public note publishing

These features would distract from validating the core interaction:

> Can a user move temporary information across devices faster and more naturally than sending it to themselves?

---

# 12. Technical Stack

## PWA frontend

```text
React
TypeScript
Vite or Next.js
Service worker
Web App Manifest
IndexedDB
Dexie
Yjs
WebRTC
WebSocket
```

## Backend

```text
FastAPI, Hono, or Fastify
PostgreSQL
Redis
WebSocket signaling
S3-compatible object storage
coturn
```

## Local persistence

```text
IndexedDB
Yjs document updates
Pending delivery queue
Encrypted object cache
Device metadata
```

## Cryptography

```text
Web Crypto API
Ed25519 device signatures
X25519 key agreement
AES-GCM or ChaCha20-Poly1305 payload encryption
Rotating workspace keys
```

Browser compatibility may affect the exact cryptographic primitives, so using a reviewed cross-platform library may be preferable to implementing custom cryptography.

---

# 13. Data Model

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

---

# 14. Product Differentiation

ScreenMesh is differentiated by five design decisions.

## Device-first rather than document-first

The user sends information to a screen or device, not merely to a shared folder.

## Local-first rather than cloud-first

Devices remain useful when internet access disappears.

## Transport-independent

The system can use multiple communication methods.

## Temporary by default

Objects and workspaces can expire rather than becoming permanent clutter.

## Eventually deliverable

Content can remain queued and reach its destination later.

---

# 15. Final Product Positioning

## One-line explanation

> ScreenMesh lets you move notes, links, screenshots, files, and clipboard items between your devices, even when the devices are temporarily disconnected.

## More technical explanation

> ScreenMesh is a local-first, transport-independent device handoff layer that synchronizes encrypted objects across browsers, phones, laptops, and shared screens.

## Developer-focused pitch

> ScreenMesh is a cross-device scratchpad for developers. Send commands, logs, links, screenshots, and files between phones, laptops, test devices, and lab machines without emailing or messaging yourself.

## Longer vision

> Every screen around the user becomes part of one programmable personal workspace. Information is no longer trapped inside a specific application or device—it moves to the screen where it is needed through the best available route.
