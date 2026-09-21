# ScreenMesh Architecture Audit and Evolution

Scope: read-only audit of the current repository, including the newly added Local Companion discovery scaffold. “Implemented” below means code exists and is wired into an execution path; it does not mean independently security-audited or production-ready.

## 1. Executive overview

ScreenMesh is a local-first, multi-device object-delivery system. Its core abstraction is not “files” or “chat”; it is a signed, encrypted `MeshObject` delivered from one device identity to one or more other device identities through interchangeable network paths.

```text
Web / Android / desktop-agent UI
        ↓
MeshObject + operation model
        ↓
Per-device identity + pairwise ratchet encryption
        ↓
MeshEngine delivery / acknowledgement / outbox
        ↓
WebRTC direct or encrypted WebSocket relay
        ↓
Receiving MeshEngine
        ↓
Local device storage and UI
```

Key terms:

| Term | Actual meaning in code |
|---|---|
| Device | A unique Ed25519/X25519 identity plus a device ID, name, type, and optional capabilities. |
| Workspace | A relay-registered membership group with an owner device and a current pairing token. |
| Object | A text, link, file, image, clipboard item, command, document, checklist, or structured agent task. |
| Transport | A carrier for encrypted envelope bytes; it must not need plaintext. |
| Route | The currently usable path to a recipient: currently WebRTC direct, relay, or later queued delivery. |
| Relay | Fastify server holding membership, presence, encrypted envelopes, and offline queues. |
| Encryption boundary | The sender encrypts before transport; the recipient verifies and decrypts after transport. |
| Trusted | Paired devices, their local applications, and their local identity keys. |
| Untrusted or semi-trusted | Relay, local network, WebRTC signaling path, carrier devices, and network observers. |

The current implementation is strongest as a browser/Android/Node device-mesh using a hosted relay for coordination and fallback. It is not yet a complete LAN-first transport system.

## 2. Architecture before Local Companion

Before the companion scaffold, the actual web path was:

```text
Device A PWA
  ├─ IndexedDB: identity, workspace, object data, ratchets
  ├─ MeshEngine
  │   ├─ WebRTC data channel if already available
  │   └─ WebSocket relay fallback
  ↓
Relay
  ├─ workspace registry / pairing-token state
  ├─ presence
  ├─ WebRTC signaling
  └─ encrypted offline queue
  ↓
Device B PWA / Android app / desktop agent
  ├─ verifies signature
  ├─ derives ratchet key
  ├─ decrypts operation payload
  └─ persists object locally
```

### Pairing

1. The owner creates a workspace in [app.ts](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\lib\app.ts).
2. A browser-generated identity has:
   - Ed25519 signing keys.
   - X25519 agreement keys.
   - UUID device ID.
3. The owner creates a pairing payload in [pairing.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\pairing.ts).
4. The relay records the pairing token and expiry in [registry.ts](C:\Users\nidhi\dev\ScreenMesh\apps\server\src\registry.ts).
5. The QR/link carries the workspace ID, pairing token, pairing secret, and expiry.
6. The joining device generates its own identity and redeems the token through `POST /workspaces/:id/join`.
7. The relay returns workspace/device roster metadata.
8. Devices later establish pairwise ratchet sessions using the QR pairing secret plus X25519 identity agreement.

### Full payload lifecycle: text sent from A to B

```text
User enters text in Send.tsx
  ↓
MeshEngine.sendObject()
  ↓
Plaintext MeshObject persisted in sender IndexedDB
  ↓
CREATE_OBJECT + SEND_TO_DEVICE operations created
  ↓
Operations JSON is encrypted into a SecureEnvelope
  ↓
Envelope is Ed25519-signed
  ↓
WebRTC direct if open
  ↓ otherwise
Relay WebSocket sends/stores envelope
  ↓
Recipient receives envelope
  ↓
verifyEnvelope(): expiry + Ed25519 signature
  ↓
ratchet derives matching AES-GCM message key
  ↓
decryptEnvelope()
  ↓
recipient applies operations and stores plaintext object locally
  ↓
recipient sends MARK_DELIVERED / MARK_OPENED operations
```

Major code path:

- UI: [Send.tsx](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\components\Send.tsx)
- Object/delivery creation: [engine.ts](C:\Users\nidhi\dev\ScreenMesh\packages\sync\src\engine.ts:200)
- Envelope creation: [envelope.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\envelope.ts)
- Ratchet: [ratchet.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\ratchet.ts)
- Direct path: [webrtc.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\webrtc.ts)
- Relay path: [websocket.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\websocket.ts)
- Relay: [relay.ts](C:\Users\nidhi\dev\ScreenMesh\apps\server\src\relay.ts)

### Online, offline, and direct behavior

| Situation | Actual behavior |
|---|---|
| WebRTC data channel open | Encrypted envelope goes directly over the data channel. |
| WebRTC unavailable/not ready | Envelope goes through relay WebSocket. |
| Recipient offline but relay available | Relay queues encrypted envelope for later authenticated connection. |
| Neither direct nor relay is usable | Sender keeps encrypted bundle in local outbox. |
| Other trusted device is online | Store-carry-forward can offer an encrypted bundle to a carrier. |
| Receiver reconnects | Relay queue and local outbox can drain. |

The current implementation does not do generic LAN discovery or generic LAN socket transport.

## 3. Component inventory

| Component | Location | Actual responsibility | Trust/data access | Status |
|---|---|---|---|---|
| Web PWA | `apps/web` | User UI, identity, workspace, local object store, encryption, relay/WebRTC client. | Holds local plaintext and browser keys. | Implemented. |
| Web UI | `apps/web/src/components` | Pairing, send, inbox, library, devices. | Reads local plaintext objects. | Implemented. |
| App lifecycle | [app.ts](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\lib\app.ts) | Create/join workspace, pairing QR, engine construction. | Holds pairing secret and local identity context. | Implemented. |
| Storage | [db.ts](C:\Users\nidhi\dev\ScreenMesh\packages\storage\src\db.ts) | Dexie/IndexedDB tables. | Stores plaintext objects, metadata, device roster, ratchets. | Implemented. |
| Protocol | `packages/protocol` | Shared object, operation, envelope, relay types. | Types only; no crypto. | Implemented. |
| Identity | [identity.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\identity.ts) | Ed25519 signing and X25519 agreement identities. | Private keys remain on device; Node agent exports keys for persistence. | Implemented. |
| Pairing | [pairing.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\pairing.ts) | Generates/parses compact `SM1` pairing codes. | QR carries pairing secret/token. | Implemented. |
| Ratchet | [ratchet.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\ratchet.ts) | Pairwise ratchet keys and per-message encryption keys. | Device-side only. | Implemented, simplified X3DH-style bootstrap. |
| Sync engine | [engine.ts](C:\Users\nidhi\dev\ScreenMesh\packages\sync\src\engine.ts) | Operations, envelopes, delivery state, direct/relay fallback, carry. | Sees plaintext before encryption and after decryption. | Implemented. |
| WebRTC direct | [webrtc.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\webrtc.ts) | Browser data channel; relay forwards signaling. | Carries encrypted envelope bytes. | Implemented. |
| Relay transport | [websocket.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\websocket.ts) | Authenticated WebSocket relay transport. | Carries encrypted envelope bytes. | Implemented. |
| Generic negotiator | [negotiator.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\negotiator.ts) | Generic route-selection abstraction. | No plaintext. | Partial; not wired into web runtime. |
| QR transport | [qr.ts](C:\Users\nidhi\dev\ScreenMesh\packages\transport\src\qr.ts) | Placeholder transport abstraction. | No transport implementation. | Scaffolded. |
| Relay backend | `apps/server` | Registry, join/token API, presence, queues, relay forwarding. | Sees metadata and ciphertext; not plaintext. | Implemented, in-memory registry. |
| Android app | `apps/android` | Native identity, relay pairing, relay transport, nearby experiments. | Holds plaintext and local private keys. | Implemented/partial depending on transport. |
| Desktop agent | `apps/agent` | Node-based trusted endpoint, relay connection, command/task approval. | Holds persisted extractable private key and plaintext received objects. | Implemented CLI; packaging absent. |
| Browser extension | `apps/companion-extension` | Route-list bridge from approved website to companion. | Can disclose local route metadata to approved origin. | Scaffolded/development setup. |
| Local Companion | [companion.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\src\companion.ts) | Enumerates local non-loopback IPv4 interface metadata. | Only route names/address metadata today. | Route discovery only. |

## 4. Data-flow audit

### Pair a device

```text
Owner PWA
  → createPairingPayload()
  → POST workspace / pairing token to relay
  → QR contains SM1 payload
  → joining device decodes payload
  → POST join with token + new device public keys
  → relay adds device and marks token used
  → joining device stores workspace secret + roster
  → relay WebSocket authentication begins
```

Plaintext locations:

- Owner browser memory and IndexedDB.
- Joining device memory and local storage.
- QR screen/camera image.
- Pairing secret is visible to whoever can read the QR payload.

Encrypted locations:

- Pairing code itself is not encrypted.
- Later application payloads are encrypted.

Authentication/authorization:

- Join authorization is possession of unexpired, unused pairing token.
- Relay session authentication is Ed25519 challenge signing.
- Pairwise message authenticity is envelope signature verification.

### Text, link, and clipboard

All use the same object/envelope pipeline. Links and clipboard are text-shaped objects. Clipboard is read from the browser clipboard only after browser permission/user action.

Clipboard “self-destruct” is application behavior, not remote cryptographic erasure. It can delete the local object after opening or expiry, but cannot erase screenshots, copied plaintext, backups, or another paired device that already retained data.

### File/image

Files are stored as base64 content locally. Large files are chunked into multiple encrypted `FILE_CHUNK` operations. Each chunk gets its own envelope and can be carried/queued.

### Command and agent task

```text
Sender creates command or agent_task object
  → encrypted delivery to desktop agent
  → agent marks it opened
  → terminal prompt requires explicit approval
  → only then shell/file handler runs
  → result returns as encrypted text object
```

The important limitation: agent commands are powerful. Human approval exists in [handleObject.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\src\handleObject.ts), but the desktop agent is inherently a high-trust endpoint.

### Collaborative document editing

`document`/editable objects use Yjs updates:

```text
editText()
  → update local Y.Doc
  → persist Yjs state locally
  → broadcast YJS_UPDATE operations
  → receiver applies Yjs update
```

This is actual collaboration logic, not merely UI text replacement.

### Device discovery

Current web device discovery is relay presence, not LAN discovery:

```text
Authenticated relay connection
  → relay publishes presence roster
  → MeshEngine updates devices table
  → UI displays online/offline devices
```

### Revocation

```text
Owner UI
  → POST /workspaces/:id/revoke
  → relay removes/rejects device
  → relay disconnects target
  → owner MeshEngine broadcasts REVOKE_DEVICE
  → peers remove local device/ratchet state
```

The intended behavior is sound, but the HTTP owner-authorization model is weak: requests identify the owner by a submitted device ID rather than a signed proof.

### Expiration and delete

- Object expiry is checked in engine lifecycle/sweeps.
- Envelope expiry is verified before decryption.
- Local delete in `deleteObjectLocal()` is explicitly local-only.
- “Self-destruct” is therefore not guaranteed deletion from every device or any external copy.

### Capability routing

Devices self-advertise strings such as `terminal` and `filesystem`. `resolveCapability()` ranks online matching devices first. This is routing convenience, not authorization or attestation; a malicious paired device can claim a capability.

## 5. Security architecture

### Identity and keys

Each device generates:

- Ed25519 signing keypair.
- X25519 agreement keypair.
- UUID device ID.

Browser keys are non-extractable by default and persisted through IndexedDB. The Node desktop agent uses extractable keys because it serializes identity to disk; that is a materially weaker local-storage posture.

### Pairwise ratchet

The initial ratchet root is derived from:

```text
X25519(my private identity key, peer public identity key)
+ QR pairing secret
+ workspace ID
+ sorted device IDs
```

This is not full X3DH. The first exchange uses long-term identity material; after a reply, fresh ratchet key material improves forward secrecy. That tradeoff is documented directly in [ratchet.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\ratchet.ts).

### Envelope encryption

A `SecureEnvelope` contains:

- Sender/recipient/workspace IDs.
- Timestamps and optional expiry.
- Ratchet header.
- AES-GCM ciphertext.
- Ed25519 signature.

The relay and network can see outer metadata, ciphertext size, device IDs, timing, recipient routing, and potentially source IP. They should not see object plaintext or ratchet message keys.

### Pairing-token weaknesses

Current strengths:

- 16 random bytes.
- Five-minute default TTL.
- Server marks token used after first successful redemption.
- Reuse after success or expiry is rejected.

Current weakness:

- `RotatePairingRequest` contains only `deviceId`, `pairingToken`, and expiry.
- The server checks whether that caller-supplied device ID equals the owner ID.
- There is no HTTP signature/challenge/session proof for minting or revoking.

Recommendation: add signed owner requests with nonce/replay protection before Local Companion pairing work.

### Threat summary

| Threat | Existing mitigation | Remaining risk |
|---|---|---|
| Malicious relay | Envelope encryption/signatures; QR secret contributes to ratchet bootstrap. | Metadata visible; relay can deny service, alter roster delivery, or serve malicious web assets. |
| Network observer | HTTPS/WSS/WebRTC transport encryption plus application envelope encryption. | Metadata/IP/timing visible; local direct paths may reveal peer IPs. |
| Stolen QR | Short TTL and one-use relay redemption. | First scanner can join; QR contains sensitive pairing secret. |
| Malicious paired device | Per-pair ratchets isolate message keys from other device pairs. | Paired endpoint can retain plaintext it legitimately receives. |
| Replay envelope | Message IDs, seen table, ratchet sequence/header, signature verification. | Bounded skipped-key design can reject heavily reordered traffic. |
| Compromised PWA origin | None sufficient at application level. | Malicious served JavaScript can access plaintext/keys in an active browser context. |
| Compromised desktop agent | Approval prompts for commands. | Agent private keys and received plaintext may be exposed. |
| Capability spoofing | None beyond pairing trust. | Capability labels are self-reported. |
| Server restart | None durable. | In-memory registry loses workspace/token state. |

## 6. Architectural comparison

General context, not a claim that ScreenMesh invented these patterns:

| Architecture | Typical path | ScreenMesh difference |
|---|---|---|
| Cloud file sharing | Device → cloud storage → device | ScreenMesh local devices retain object data; relay is intended as encrypted routing/queue, not primary plaintext storage. |
| Traditional WebSocket app | Client → server → client, server processes plaintext | ScreenMesh relay forwards encrypted envelopes and does not need payload plaintext. |
| WebRTC app | Browser peer-to-peer with signaling | ScreenMesh uses WebRTC as one route, with relay fallback and object/delivery semantics above it. |
| AirDrop-like transfer | Nearby discovery + local radio transport | ScreenMesh currently lacks equivalent cross-platform LAN discovery/transport in the PWA. |
| E2EE messenger | Pairwise encrypted messages via server | ScreenMesh uses similar per-pair ratchet concepts but models arbitrary objects, files, commands, delivery state, and device capabilities. |

## 7. Transport architecture

### Intended hierarchy

```text
LAN direct
  → WebRTC direct
  → encrypted WebSocket relay
  → native nearby
  → QR/file transfer
  → queued / carry-forward
```

### Actual hierarchy in the web app

```text
Open WebRTC direct data channel
  → encrypted WebSocket relay
  → local encrypted outbox
  → optional encrypted carrier forwarding
```

Important discrepancies:

- `TransportNegotiator` exists but is not used by `MeshEngine`.
- `lan` exists in the `TransportKind` union but has no implementation.
- `QrTransport` exists but throws for `connect()` and `send()`.
- Android BLE/NFC/Wi‑Fi Direct code exists, but Android’s main engine path is relay transport. Nearby paths are not a unified transport-negotiated production route.
- Local Companion does not participate in transport negotiation.

A `SecureEnvelope` is the transport boundary: transport adapters should see opaque envelope bytes, not application semantics or plaintext.

## 8. Why the current architecture is not the complete vision

| Gap | Current state | Needed |
|---|---|---|
| LAN transport | Missing. | Real `LanCompanionDirect`/LAN adapter. |
| LAN discovery | Companion lists local adapters only. | Explicit QR bootstrap; optional authenticated discovery later. |
| Local pairing | QR is relay-oriented. | Versioned local invitation with endpoint/pin/session data. |
| Desktop-to-phone LAN | Missing. | Desktop listener plus Android pinned-TLS client. |
| Mobile PWA LAN socket | Not practical/reliable. | Use WebRTC/relay unless managed local HTTPS architecture exists. |
| Unified negotiation | Generic class unused. | Integrate route candidates with real engine delivery. |
| Firewall/interface binding | Missing. | Explicit bind, random port, shutdown, health checks. |
| Token authority | Weak HTTP owner authorization. | Signed owner actions and replay-resistant request authorization. |
| Companion packaging | Development scaffold. | Signed installer, host-manifest registration, stable extension ID. |

## 9. Why Local Companion exists

The real problem is not merely “show the laptop IP.”

It is:

```text
How can a hosted PWA use a user-approved local process
to create a temporary authenticated direct route on one local interface,
then feed encrypted envelope bytes through that route,
without moving plaintext or workspace keys into the companion?
```

The companion must become a narrow OS/network capability provider and eventually a LAN transport host. It must not become a second cloud server or a plaintext proxy.

## 10. Current Local Companion audit

Current status: **route discovery only**.

```text
PWA
  → browser CustomEvent
  → extension content script
  → extension service worker
  → Chrome Native Messaging
  → companion stdin/stdout
  → Node os.networkInterfaces()
```

Implemented behavior:

- Non-loopback IPv4 enumeration only.
- Heuristic interface classification:
  - Wi‑Fi.
  - Ethernet.
  - VPN.
  - Virtual.
  - Other.
- Extension requires the user to approve one origin through popup UI.
- PWA displays discovered routes.

Not implemented:

- No listener.
- No route selection tied to the companion.
- No QR modification.
- No Android connection.
- No LAN socket.
- No envelope forwarding.
- No workspace-key access.
- No pairing-token minting.
- No WebRTC/TCP/HTTP/WebSocket server.
- No transport negotiator integration.

## 11. Proposed Local Companion architecture

```text
Hosted PWA
  - identity, workspace key, ratchet, plaintext
  - creates encrypted SecureEnvelope
        ↓
ScreenMesh browser extension
  - strict approved-origin check
  - typed, narrow bridge
        ↓ Native Messaging over local stdio
Desktop Companion
  - selected-interface listener lifecycle
  - no application plaintext
  - forwards encrypted envelopes only
        ↓ WSS/QUIC with pinned ephemeral key
Selected Wi-Fi/Ethernet interface
        ↓
Android ScreenMesh native client
  - verifies QR pin and one-use invite
  - verifies signatures/decrypts envelopes
  - joins normal ScreenMesh engine
```

The desktop companion should bind only to the exact selected IP, never `0.0.0.0` by default.

## 12. Proposed local-aware QR protocol

Current format:

```text
SM1.workspaceId.pairingToken.pairingSecret.expiresAt
```

Proposed versioned local format:

```text
SM2.workspaceId.pairingToken.pairingSecret.expiresAt.
    lanEndpoint.port.listenerSessionId.listenerSpkiHash
```

The exact encoding should be compact and versioned; do not place unbounded certificates or arbitrary server metadata in the QR.

The QR should contain:

- Protocol version.
- Workspace ID.
- Existing short-lived pairing token.
- Pairing secret.
- Expiry.
- Selected LAN endpoint and random port.
- Listener session ID.
- Hash/fingerprint of listener TLS public key.

It should not contain:

- Private keys.
- Full listener certificate if avoidable.
- Workspace history.
- Device private identity material.
- Persistent companion credentials.

Android flow:

1. Scan QR.
2. Parse and validate expiry/version.
3. Connect to endpoint.
4. Verify TLS key against QR SPKI fingerprint.
5. Present one-time session/token proof.
6. Register identity with authoritative relay.
7. Relay atomically consumes pairing token.
8. Establish local encrypted-envelope transport.
9. Fall back to relay if LAN session cannot be established.

The QR is a bootstrap trust channel, not the final data-encryption mechanism.

## 13. Local Companion security model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Same-Wi‑Fi attacker | TLS, QR pin, one-use token, envelope signature/ratchet. | DoS and traffic metadata remain possible. |
| Port scanner | Random high port, short listener lifetime, generic failure, rate limits. | Scanner can still observe an open port temporarily. |
| QR theft | Short TTL, single use, user-visible session, atomic consumption. | Thief can race intended device. |
| QR replay | Server-side used flag and listener-side session consumption. | Requires durable atomic server storage. |
| Fake listener/MITM | QR-pinned SPKI/TLS identity. | QR substitution remains possible if attacker controls display/origin. |
| Wrong interface | Explicit selected bind and health check; relay fallback. | Connection fails or exposes service to selected network. |
| VPN accidental bind | VPN disabled by default; warning and explicit advanced confirmation. | VPN peers could reach authenticated listener if enabled. |
| Listener left running | TTL, auto-shutdown, explicit Stop control, firewall cleanup. | Process crash cleanup must be tested. |
| Malicious website | Exact approved extension origin; narrow schema. | XSS in approved origin can request permitted metadata/action. |
| Malicious extension | Native-host manifest allows only stable ScreenMesh extension ID. | Compromised ScreenMesh extension remains privileged. |
| Compromised desktop | Signed installer, OS permissions, key protection. | A fully compromised desktop defeats local confidentiality. |

## 14. Why Android native is the first local target

### Desktop Companion → Android native

Feasible because Android can:

- Use a pinned TLS certificate/public key from QR.
- Open a direct socket intentionally.
- Handle custom protocol framing.
- Keep native transport state.
- Enforce explicit user permissions and lifecycle.

### Desktop Companion → mobile browser PWA

Hard because:

- HTTPS PWA → `http://192.168.x.x` is blockable mixed content.
- Cross-origin LAN requests need CORS.
- Public-to-private network access is affected by Private Network Access.
- `https://192.168.x.x` needs a phone-trusted certificate valid for the IP/name.
- Browser JavaScript cannot silently accept self-signed certificates.
- Mobile Chrome does not generally support the required extension/native-messaging bridge.

Chrome’s Private Network Access model explicitly targets public-site access to private network endpoints; future enforcement cannot be assumed away. [Chrome PNA documentation](https://developer.chrome.com/blog/private-network-access-preflight)

Practical browser fallback:

```text
Hosted PWA
  → WebRTC direct if ICE succeeds
  → encrypted relay if it does not
```

## 15. Transport negotiation after Local Companion

Recommended delivery order:

```text
1. LanCompanionDirect
   - only after QR/session/tls validation
2. WebRtcDirect
3. WebSocketRelayTransport
4. Native nearby transport
5. QR/file transport
6. Local outbox + encrypted carry-forward
```

The user should choose “Pair device,” not manually reason about individual transports. The application should select a verified, reachable route and expose only understandable status:

```text
Connected directly
Connecting locally
Using relay
Queued safely
```

Local Companion is not itself the new transport. It enables a new LAN direct transport adapter.

## 16. Before versus after

### Before Local Companion

```text
PWA / Android / Agent
  → WebRTC direct when available
  → encrypted relay otherwise
  → encrypted queue/carrier if unavailable
  → receiving device
```

### Intended after Local Companion

```text
Desktop PWA
  → encrypted envelope
  → companion-assisted LAN direct, if explicitly paired and reachable
  → WebRTC direct
  → encrypted relay
  → encrypted queue/carrier
  → receiving device
```

The object model, signature model, ratchet, and delivery semantics remain unchanged. The transport layer gains another route.

## 17. Security-boundary diagram

```text
Trusted sender device
  - plaintext object
  - Ed25519/X25519 private keys
  - workspace pairing secret
  - ratchet session state
        ↓ encrypt + sign
------------------------------------------------
Untrusted transport boundary
  - LAN
  - WebRTC data channel
  - relay
  - carrier device
  - network observer
  sees ciphertext + routing metadata
------------------------------------------------
        ↓ verify + decrypt
Trusted receiver device
  - ratchet session state
  - recipient plaintext object
  - local persistence
```

Proposed companion-specific keys:

```text
PWA: application identity / plaintext / ratchet
Companion: ephemeral listener TLS key, token hash, encrypted envelopes
Android: application identity / plaintext / ratchet / pinned listener key
Relay: pairing-token state, public keys, metadata, encrypted envelopes
```

## 18. End-to-end example

User has laptop PWA, Android phone, and desktop agent.

| Case | Actual current behavior | Intended future behavior |
|---|---|---|
| Phone on same Wi‑Fi | PWA tries WebRTC; relay fallback. | Companion LAN route first if explicit local session exists. |
| Phone on another network | WebRTC may work through ICE; relay fallback. | Same; LAN route is unavailable. |
| WebRTC works | Encrypted data channel carries envelope. | LAN may win locally; otherwise unchanged. |
| WebRTC fails | Relay forwards/queues ciphertext. | Same fallback. |
| Phone offline | Relay/local outbox/carry retains encrypted bundle. | Same. |
| Expired QR | Relay rejects pairing token. | Local listener also rejects and shuts down. |
| Attacker obtains QR | Attacker can race to redeem current token. | Same basic residual risk; one-use/expiry/pinning limit reuse/MITM. |
| Listener expires mid-pair | Not applicable today. | Android gets generic expiry failure and falls back to relay pairing if possible. |

## 19. Implementation roadmap

| Phase | Work | Definition of done |
|---|---|---|
| 0: Harden foundation | Package companion; stable extension ID; installer-created native host; signed owner authorization for rotate/revoke. | No development launcher/manual host template required; owner actions are signed/replay-resistant. |
| 1: Secure listener | Add start/stop LAN session, selected-IP bind, random port, ephemeral TLS key, timeout. | No default broad bind; listener passes bind/firewall/shutdown tests. |
| 2: Local invitation | Add versioned `SM2` protocol and atomic server/session token redemption. | QR parser, expiry, replay, malformed input, scan-density tests pass. |
| 3: Android client | Android pinned-TLS local transport and QR bootstrap. | Real-device same-Wi‑Fi pairing/delivery/failover tested. |
| 4: Engine integration | Add `LanCompanionDirect` and composite direct channel before WebRTC. | Route order, fallback, duplicate prevention, queue drain tested. |
| 5: UX | Companion status, route selection, VPN warning, active listener stop control. | User can pair without understanding transports. |
| 6: Browser strategy | Retain WebRTC/relay for mobile PWA unless managed local HTTPS exists. | Explicitly documented support matrix; no unsafe HTTP workaround. |
| 7: Security validation | Threat tests, rate limiting, pin mismatch, QR theft race, interface/failure matrix. | Documented residual risk and repeatable test suite. |

## 20. Final intended architecture

```text
                ┌────────────────────┐
                │ Hosted ScreenMesh  │
                │ PWA / Relay        │
                └─────────┬──────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
  LAN Companion      WebRTC direct      Relay fallback
       │                  │                  │
       ▼                  ▼                  ▼
Android native      Browser peer       Encrypted queue
       │                                     │
       └────────────── SecureEnvelope ───────┘
```

Open problems:

- Signed ownership for sensitive relay HTTP actions.
- Durable server registry storage.
- Companion installer/extension lifecycle.
- Local TLS certificate pinning design.
- Android physical-device validation.
- Browser PWA local-network support.
- Unified transport negotiation.
- Security audit of cryptographic and relay implementation.

## 21. Final audit table

| Capability | Current implementation | Security model | Actual status | Limitation | Next step |
|---|---|---|---|---|---|
| Device identity | Ed25519/X25519 identities | Private keys device-local | Implemented | Node keys extractable on disk | OS-secure agent storage |
| Pairing QR | `SM1` token/secret/TTL | QR is bearer trust ceremony | Implemented | QR theft/race; no endpoint data | Signed owner actions, SM2 |
| Relay auth | Ed25519 challenge | Device signs server nonce | Implemented | Relay metadata visibility | Durable registry/rate limits |
| Envelope crypto | AES-GCM + Ed25519 + ratchet | End-to-end device encryption | Implemented | No independent audit; simplified bootstrap | External review/prekeys |
| WebRTC | Data channel with relay signaling | Encrypted envelope payload | Implemented | No manual interface control | Better route telemetry |
| Relay | WebSocket + offline queue | Ciphertext forwarding | Implemented | In-memory registry/state | Durable backend |
| Queue/carry | Encrypted bundles | Carrier cannot decrypt pairwise envelope | Implemented | Operational complexity/unverified scale | Reliability tests |
| Android relay app | Native join + relay transport | Same pairing/ratchet model | Implemented | Reference UI; nearby path partial | Real-device coverage |
| Android nearby | BLE/NFC/Wi‑Fi Direct code | QR/bootstrap or raw nearby bytes | Partial | Not unified into primary engine flow | Transport integration |
| Desktop agent | CLI relay device + approval | Human approval before command/task | Implemented | No packaged app | Installer/background service |
| Companion route discovery | Native route list + extension bridge | Exact extension/origin intended | Partial | Metadata only, manual setup | Package/harden |
| LAN companion transport | None | None | Missing | No listener or phone connection | Phases 1–4 |
| Mobile PWA LAN socket | None | Browser restrictions | Missing | HTTPS/PNA/CORS/cert constraints | Use WebRTC/relay |

## 22. Video storyline

| Act | What to show | Technical point | Transition |
|---|---|---|---|
| 1. Problem | Laptop, phone, desktop with fragmented state | Devices need to move work, not merely upload files. | Introduce object-delivery model. |
| 2. Before Companion | Device → WebRTC/relay → device diagram | Current system is multi-route, but not LAN-companion transport. | Show object model. |
| 3. Identity + encryption | Identity keys, QR secret, ratchet diagram | Devices—not relay—hold message keys. | Show envelope boundary. |
| 4. Transport architecture | Direct/relay/queue lanes | Application semantics stay above transport. | Show actual path. |
| 5. Relay visibility | Relay sees ciphertext/metadata split diagram | Relay routes; it does not need plaintext. | Explain offline queue. |
| 6. Current limitations | Greyed LAN/direct discovery lane | Current PWA cannot enumerate or host local routes. | Introduce browser sandbox. |
| 7. Why Companion | Browser → extension → native process | OS-network access requires a local trusted program. | Distinguish discovery from transport. |
| 8. Companion today | Route-list-only diagram | Current implementation is discovery only. | Explain what is missing. |
| 9. Secure LAN pairing | SM1 → proposed SM2 QR diagram | Endpoint, pin, token, expiry bootstrap temporary local session. | Move to Android target. |
| 10. Negotiation | LAN → WebRTC → relay → queue waterfall | Route choice should be automatic and verified. | Compare before/after. |
| 11. Before versus after | Two side-by-side path diagrams | Data model stays; transport choices expand. | Show trust boundaries. |
| 12. Final architecture | Full device/relay/companion diagram | Companion adds a secure local route without becoming plaintext infrastructure. | End with open engineering work. |

## Architecture in one page

ScreenMesh currently delivers signed, ratchet-encrypted objects between device identities. The web runtime tries WebRTC direct delivery first and falls back to an encrypted WebSocket relay, local outbox, and optional encrypted carry-forward. The relay manages workspace membership, presence, token redemption, and ciphertext queues; it is not intended to hold plaintext object data.

The current Local Companion does not change transport. It only lets a user-approved Chromium extension ask a local Node process for non-loopback IPv4 route metadata, then displays that list in the Pair UI. It has no listener, no selected-route QR, no Android connection, and no envelope forwarding.

The correct next evolution is a narrow desktop companion that binds a temporary, pinned-TLS listener to one selected LAN interface, forwards opaque encrypted envelopes to Android native ScreenMesh, and integrates as a new direct transport ahead of WebRTC. Mobile browser PWA local sockets should remain a later/non-primary path because HTTPS, certificate trust, CORS, and Private Network Access make raw LAN connections unreliable.