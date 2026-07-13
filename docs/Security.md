# ScreenMesh Security Model

ScreenMesh's secure channel is precisely:

> **An end-to-end encrypted application-layer tunnel between trusted devices.**

It tunnels only its own structured protocol — notes, files, clipboard items, commands, workspace events, CRDT updates — not arbitrary IP traffic. The accurate positioning is *a secure cross-device handoff channel, not a general-purpose network tunnel*.

---

## 1. Device identity

Each device generates its own cryptographic identity on first launch:

```text
private key → never leaves the device
public key  → shared during pairing
```

- **Signing:** Ed25519 (message authentication, bundle signatures)
- **Key agreement:** X25519 (deriving shared session keys)
- **Payload encryption:** AES-GCM (ChaCha20-Poly1305 as an alternative)

All via the Web Crypto API. Browser support for the exact primitives varies, so `@screenmesh/crypto` isolates them behind a small interface — if a reviewed cross-platform library (libsodium.js) proves more reliable, it swaps in without touching callers. **We do not invent cryptography**; for forward secrecy and session ratcheting we will adopt a reviewed protocol (Noise Protocol Framework, Double Ratchet-style sessions, or MLS for multi-device rooms) rather than a homegrown scheme.

## 2. Pairing

Pairing is the explicit trust ceremony. The QR code (or short pairing code / shared link) contains:

```text
device ID
public key
ephemeral pairing token
workspace ID
expiry
```

Both devices verify each other's identity during pairing; the ephemeral token prevents a bystander who photographs the QR later from joining (it expires and is single-use). Temporary workspaces (labs, meeting rooms, hackathons) get short expiries by default, and the pairing screen always displays the expiry.

**Revocation:** users can revoke a device at any time (`REVOKE_DEVICE` operation). Revoked devices are excluded from future workspace key rotations, so they cannot decrypt anything sent after revocation.

## 3. Message envelope

Every message, on every transport, is wrapped identically:

```ts
interface SecureEnvelope {
  version: number;
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  workspaceId: string;
  createdAt: number;
  expiresAt?: number;
  sequenceNumber: number;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}
```

The recipient verifies, before decrypting:

1. **Signature** — was it really sent by that device, unmodified?
2. **Workspace** — does it belong to a workspace we share with the sender?
3. **Freshness** — `expiresAt` not passed; `messageId` not seen before; `sequenceNumber` consistent with the sender's last known sequence.

Encryption happens **before** the envelope reaches any transport:

```text
plaintext → encrypt on sender → WebRTC / relay / nearby / QR → decrypt on recipient
```

A relay server, or a trusted device carrying a store–carry–forward bundle, only ever handles ciphertext. It cannot read notes, files, clipboard data, commands, or attachments.

## 4. Replay protection

An attacker must not be able to resend an old message — especially once command objects exist. Defenses, in combination:

- Unique message IDs with received-message tracking
- Monotonic per-sender sequence numbers
- Envelope expiration times
- Nonces in the AEAD construction

Store–carry–forward bundles additionally carry `hopLimit` and `expiresAt` so stale bundles die rather than circulate.

## 5. Forward secrecy and key rotation

Workspace/session keys rotate periodically so that compromising a current key does not expose past traffic. Rotation also implements revocation: a revoked device simply never receives the next key. The MVP ships rotating workspace keys; a proper ratcheting session protocol (Noise / Double Ratchet / MLS) is the planned upgrade path.

## 6. Honest limitations (threat model)

Payload encryption does not hide **metadata**. Depending on mode, an observer or the relay may learn:

| Mode | Who sees what |
|---|---|
| Direct (WebRTC) | Peers see each other's network information (IPs). Low latency, no server payload handling — but P2P ≠ anonymous. |
| Relayed | Server sees device identifiers, message sizes, delivery times, source IPs, destination workspace — never payloads. |
| Store–carry–forward | Carrier devices see bundle metadata (source, destination, size, expiry) — never payloads. |

## 7. What ScreenMesh is not

ScreenMesh should not claim to be:

- A VPN or general TCP tunnel (it does not carry arbitrary IP traffic)
- A replacement for SSH or a secure remote desktop protocol
- A Tor-style anonymous network or a zero-metadata messaging system
- A replacement for Signal

## 8. Command safety

Command objects (`pnpm run dev` sent phone → laptop) are **never executed automatically** in the MVP — they arrive as cards with *Copy / Open terminal / Save to history* actions only. A future trusted desktop agent may support controlled execution, always behind an explicit per-command approval prompt on the receiving device:

```text
Incoming command from Nidhi's Phone

pnpm run integration-test

[Reject] [Copy] [Run]
```

Replay protection (section 4) is a hard prerequisite for that feature.
