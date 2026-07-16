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
- **Key agreement:** X25519 (session bootstrap and per-message ratcheting — see §5)
- **Payload encryption:** AES-GCM, keyed per message by the ratchet, not a shared workspace secret

All via the Web Crypto API. Browser support for the exact primitives varies, so `@screenmesh/crypto` isolates them behind a small interface — if a reviewed cross-platform library (libsodium.js) proves more reliable, it swaps in without touching callers.

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

The QR-transported secret no longer directly encrypts anything (see §5) — it seeds the pairwise ratchet session every pair of devices in the workspace bootstraps independently, so it remains the true out-of-band trust anchor even though message keys are now per-pair and per-message.

**Revocation:** users can revoke a device at any time (`REVOKE_DEVICE` operation). The relay immediately refuses that device's connections, its device roster entry is pruned everywhere, and every remaining device drops its local ratchet session with it. No group-wide rekey is needed or performed — see §5 for why per-pair ratcheting makes that unnecessary, unlike the shared-workspace-key design this replaced.

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
  ratchetPublicKeyB64: string;    // sender's current ratchet public key
  messageNumber: number;          // position in that sending chain
  previousChainLength: number;    // lets the receiver drain a superseded chain
  ciphertext: Uint8Array;
  signature: Uint8Array;
}
```

The `ratchetPublicKeyB64`/`messageNumber`/`previousChainLength` fields are exactly what the recipient needs to derive the one-time AES-GCM key that decrypts `ciphertext` — see §5. They travel in the clear (like the rest of the envelope header) but are covered by the signature, so a MITM can't swap in a different ratchet position without invalidating it.

**Verification order matters.** The recipient MUST check authenticity before touching the ratchet header for anything:

1. **Signature** — was it really sent by that device, unmodified? (`verifyEnvelope`)
2. **Workspace** — does it belong to a workspace we share with the sender?
3. **Freshness** — `expiresAt` not passed; `messageId` not seen before.
4. **Only then**: derive the message key from the (now-trusted) ratchet header (`ratchetDecrypt`) and decrypt (`decryptEnvelope`).

`packages/crypto/src/envelope.ts` enforces this by exposing `verifyEnvelope` and `decryptEnvelope` as separate calls rather than one combined "open" — deriving a message key mutates the ratchet session's state, so a forged header must never be allowed to do that before the signature is checked.

Encryption happens **before** the envelope reaches any transport:

```text
plaintext → encrypt on sender → WebRTC / relay / nearby / QR → decrypt on recipient
```

A relay server, or a trusted device carrying a store–carry–forward bundle, only ever *routes* ciphertext — it never decrypts it to do so. See §6 for the honest caveat on what a carrier could technically do with today's shared-workspace-key model, versus what the app's routing exposes.

**Carrier forwarding and the relay's sender check.** Normally the relay rejects any envelope whose `senderDeviceId` doesn't match the authenticated connection sending it — a device can't claim to speak for another device over the wire. Store–carry–forward is the deliberate exception: a carrier relays a bundle it did not create, so it uses a distinct `forward` relay message that skips that check. This is safe because the relay was never the thing authenticating the envelope's origin — the **destination's own signature verification** on the inner envelope is, and a carrier cannot forge that signature. The relay's sender check is a defense-in-depth convenience for the common case, not a substitute for it.

## 4. Replay protection

An attacker must not be able to resend an old message — especially once command objects exist. Defenses, in combination:

- Unique message IDs with received-message tracking
- Monotonic per-sender sequence numbers
- Envelope expiration times
- Nonces in the AEAD construction

Store–carry–forward bundles additionally carry `hopLimit` and `expiresAt` so stale bundles die rather than circulate.

## 5. Forward secrecy: per-pair Double Ratchet

Every pair of devices in a workspace runs its own **Double Ratchet session** (`packages/crypto/src/ratchet.ts`) — the same construction Signal uses. There is no shared workspace key; each envelope is encrypted with a key derived for that one message, used once, and never reconstructible from later state.

**Bootstrap ("X3DH-lite").** Both sides compute the same initial root key from:

```text
rootKey0 = HKDF(salt = pairingSecret, ikm = ECDH(myIdentity, theirIdentity), info = workspaceId | sorted(deviceIdA, deviceIdB))
```

`pairingSecret` is the value that traveled over the QR — the out-of-band channel. Each device's long-term X25519 identity key is learned via the relay's HTTP join API, which is **not independently authenticated**; a relay that substituted identity keys in transit still couldn't derive `rootKey0` without also knowing the QR secret. Both sides seed their ratchet keypair with their *own* identity keypair (not a freshly generated one), specifically so either side can send first without having received anything — a full X3DH with published one-time prekeys would avoid even this, but needs prekey-bundle server infrastructure we don't have yet.

**Every subsequent key requires a fresh Diffie–Hellman exchange.** Each side keeps a "ratchet keypair" that changes every time it needs to reply after the peer's key changes; the resulting key material is mixed into the root key via HKDF, and messages within a chain are derived from a one-way HMAC chain (`stepChain`) — the chain key that produced message *N* is discarded before message *N+1* is derived. Concretely:

- Knowing the pairing secret and both devices' long-term identity keys only lets an attacker compute `rootKey0` — the seed for the *very first* exchange.
- From the second round trip onward, deriving the current message key additionally requires an **ephemeral private key** that was generated fresh and never transmitted — observable network traffic (the public halves) isn't enough.
- This means: compromising the pairing secret, the identity keys, or a past session snapshot does **not** expose message keys from after the first round trip, as long as ephemeral private keys are genuinely discarded after use. The session **self-heals** the first time the peer replies.

**Out-of-order tolerance is real but bounded**, not unlimited: a capped skipped-key cache (`MAX_SKIPPED_KEYS`, `MAX_SKIP_PER_STEP` in ratchet.ts) lets a handful of reordered deliveries (the realistic case in this system — store–carry–forward or the outbox occasionally delivering out of send order) still decrypt; a message skipped further than that, or arriving after its slot was evicted from the cache, is unrecoverable by design (same as a genuine replay — see §4).

**Revocation is now trivial and pairwise-isolated.** Since every pair's secrecy is independent, revoking device C never requires telling devices A and B to rekey anything — their session with each other never involved C's key material in the first place. The owner simply stops the relay from accepting C's connections and drops the local ratchet session with it (`MeshEngine.revokeDevice`); A–B traffic is completely unaffected, proven by `packages/sync/scripts/engine-smoke.ts`'s revocation steps. This **replaces** the earlier `ROTATE_KEY` / epoch-based workspace-key rotation mechanism entirely — that mechanism is retired, not layered underneath this.

Sessions persist locally (`packages/storage`'s `ratchets` table) so they survive reloads; `RatchetSession` objects (including non-extractable `CryptoKey`s) structured-clone into IndexedDB the same way device identities do.

## 6. Honest limitations (threat model)

Payload encryption does not hide **metadata**. Depending on mode, an observer or the relay may learn:

| Mode | Who sees what |
|---|---|
| Direct (WebRTC) | Peers see each other's network information (IPs). Low latency, no server payload handling — but P2P ≠ anonymous. |
| Relayed | Server sees device identifiers, message sizes, delivery times, source IPs, destination workspace — never payloads. Ratchet sessions are established device-to-device; the relay never holds message-key material. |
| Store–carry–forward | Carrier devices see bundle metadata (source, destination, size, expiry) through the app — and, as of the per-pair ratchet (§5), **genuinely cannot decrypt what they're carrying**: the inner envelope is encrypted with a message key from the ratchet session between the original sender and the true destination, a session the carrier was never part of. This closes the gap this table used to document under the old shared-workspace-key design. |

**Capability routing is self-reported and unverified.** A device advertises its own capabilities (`"terminal"`, `"filesystem"`, ...) via presence; nothing cryptographically attests that a device advertising `"terminal"` actually exposes one safely, or that it isn't lying to attract sensitive sends. Route-to-capability is a convenience for choosing *which paired, already-trusted device* to address — it is not a privilege or sandboxing boundary, and pairing trust (§2) is still the only thing standing between a device and receiving whatever gets routed to it.

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
