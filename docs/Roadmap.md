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
- [x] Device revocation (owner-only; relay access cut immediately, roster pruned everywhere; per-pair ratcheting since Phase 5 means no group rekey is even needed — see Security.md §5)

**Objects**
- [x] Text, links, code snippets
- [x] Images and small files (≤ 25 MB; secure file drop chunks anything above ~150 KB into multiple small envelopes — see Phase 5)
- [x] Checklists (toggle/add items on any device; last-write-wins merge)
- [x] Chunked transfer for larger files (Phase 5 — over whatever transport is active, not WebRTC-specific)

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
- [x] End-to-end encrypted envelopes (AES-GCM + Ed25519 signatures)
- [x] Replay protection: message-ID dedupe, sequence numbers, envelope expiry
- [x] Workspace-key epoch rotation on revocation — **superseded in Phase 5** by per-pair Double Ratchet sessions (see Security.md §5); the epoch/`ROTATE_KEY` mechanism has been removed, not kept alongside it

## Phase 2 — Eventual delivery ✅

- [x] Expiring objects: optional TTL per send, enforced by a periodic sweep on every device — deletes the object locally and marks any still-in-flight delivery `expired` (history stays visible; only `opened` deliveries are left alone)
- [x] Delivery options: `deleteAfterOpening` (recipient's copy vanishes right after `markOpened`); `requireConfirmation` (delivery sits as `pending` — content is visible but actions are gated — until the recipient explicitly Accepts or Rejects; rejecting notifies the sender and never executes/opens anything)
- [x] Store–carry–forward: encrypted `DeliveryBundle`s (already defined in the protocol, previously unused) now actually get carried. A real object send is carry-eligible (`DEFAULT_HOP_LIMIT`); acks/control ops are not (`hopLimit: 0`), so only genuine object deliveries fan out to carriers. A `CARRY_BUNDLE` operation hands the bundle — still sealed for the true destination — to an online peer, which holds it in a `carried` table and forwards it the moment presence shows the destination online, via a dedicated relay `forward` path (see Security.md — the relay's normal sender-identity check doesn't apply to carriers, since the destination's own signature check is what authenticates the bundle, not the relay)
- [x] Relay-side store-and-forward for offline recipients (shipped in Phase 1; still the primary path — carry is supplemental redundancy for when the *original sender* goes away before the destination reconnects)

Known limitation at the time, resolved in Phase 5: this shipped when all workspace devices still shared one symmetric key, so a carrier *could* technically have decrypted what it was holding. Per-pair Double Ratchet sessions (Security.md §5) close this — a carrier now has no session with the true destination and genuinely cannot decrypt.

## Phase 3 — Native nearby

- [~] **Android app scaffolded** (`apps/android`): a hand-ported Kotlin core of `packages/protocol`/`crypto`/`transport` (BouncyCastle for Ed25519/X25519/HKDF, OkHttp for the relay WebSocket + pairing HTTP) plus a `MeshEngine` — including store-carry-forward, `continueOnDevice`, and last-write-wins object updates, not just the original CREATE_OBJECT/SEND_TO_DEVICE minimum — identity/session persistence, and a bare reference UI, so the phone joins the same workspaces and speaks the same envelope/ratchet protocol as the web PWA and desktop agent — see docs/Android.md for exactly what's ported vs. deferred (Yjs collaborative editing and file-chunked secure drop still aren't ported; object/delivery/ratchet-session state is in-memory only, matching the desktop agent's own scope, though identity + session now survive a restart). **Not built or run** — this environment has no JDK/Android SDK/Gradle/device, so nothing beyond careful line-by-line porting against the TS source was possible here.
- [~] Bluetooth LE / Wi-Fi Direct / NFC pairing and transport — real implementations now exist in `apps/android`'s `transport/nearby/` (GATT peripheral+central for BLE, `WifiP2pManager` + TCP socket for Wi-Fi Direct, NDEF read/write for NFC), but none are wired into `MainActivity` yet (no runtime permission requests, no receiver registration, and critically: no pairing bootstrap over the nearby channel itself, so a nearby-discovered peer can't yet join a `MeshEngine` session) — see docs/Android.md. Unbuilt and untested, like the rest of `apps/android`
- Wi-Fi Aware as an optional high-throughput adapter
- NFC tap-to-pair via passive tags on shared displays

## Phase 4 — Flagship experiments

- UWB / Channel Sounding "point-to-send" targeting
- Screen-to-camera optical pairing (animated QR → invisible modulation)
- Ultrasonic discovery chirps
- Apple Multipeer / Network.framework adapter

## Phase 5 — Toward the device bus ✅

- [x] **Forward-secret per-pair Double Ratchet sessions** (Security.md §5): replaces the shared workspace-key/epoch model entirely. Each device pair bootstraps a session from the QR-transported pairing secret + X25519 identity keys, then ratchets forward with fresh ephemeral keys on every round trip — a past-state compromise doesn't expose future messages, and revocation no longer needs a group-wide rekey since sessions are pairwise. Bounded out-of-order tolerance via a capped skipped-key cache
- [x] **Temporary clipboard tunnel**: one-click "share clipboard for N minutes," built entirely on Phase 2's expiring-objects + delete-after-opening machinery — no new delivery mechanism needed
- [x] **Secure file drop**: files above ~150 KB travel as a sequence of small `FILE_CHUNK` envelopes (each independently carry-eligible) instead of one giant envelope; the recipient reassembles and materializes the object only once every chunk has arrived
- [x] **Capability routing**: devices advertise capabilities (camera, terminal, filesystem, local models, ...) via presence; a send can target "whichever device has X" (`MeshEngine.resolveCapability`, ranked online-first) instead of naming a specific device. Self-reported and unverified — a routing convenience among already-paired, already-trusted devices, not a privilege boundary (Security.md §6)
- [x] **Trusted desktop agent** (`apps/agent`): a standalone Node CLI reusing the exact same crypto/sync/transport packages as the PWA — same ratchet sessions, same relay, same store-carry-forward. Persists device identity to a local JSON file (extractable keys + PKCS8 export, since there's no IndexedDB to lean on — Security.md §1) and resumes without re-pairing. Executes `command` objects only behind an interactive terminal approval prompt; never automatic
- [x] **Agent-to-agent structured task channel**: a distinct `agent_task` object type (`{action, params}`) carries structured requests to a small handler registry (`echo`, `read_file`, `run_command`) rather than an open plugin system, still behind the same approval gate, replying with an ordinary `text` object

`packages/sync/src/engine.ts` gained one general-purpose primitive along the way: `onObjectReceived`, a callback fired once every op in an incoming envelope has been applied (not mid-envelope) — needed because the Node agent has no Dexie liveQuery to react to new objects the way the web UI does.

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
