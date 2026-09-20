# The Secure Device Bus

ScreenMesh's notes-and-clipboard interface is the visible surface. Underneath it is something more specific:

> **An end-to-end encrypted application-layer tunnel between trusted devices.**

Not a VPN. Not a general network tunnel. A structured channel that carries exactly ScreenMesh's own objects — notes, files, clipboard content, commands, structured agent requests, CRDT updates, device-control events — and nothing else.

```text
Phone
  │
  │ encrypted ScreenMesh protocol
  ▼
Laptop
```

The transport underneath can change from one moment to the next — WebRTC, a WebSocket relay, local Wi-Fi, Bluetooth LE, Wi-Fi Direct, NFC, near-ultrasonic audio, a QR-encoded bundle — but the encrypted channel riding on top of it stays the same regardless.

---

## What makes the tunnel secure

**Device identity.** Every device generates its own keypair locally — the private key never leaves the device. Pairing exchanges public keys, a device ID, a workspace ID, and a short-lived pairing token, typically over a QR code.

**End-to-end encryption.** The sender encrypts before handing anything to a transport. A relay forwarding a message only ever sees ciphertext — it cannot read notes, files, clipboard content, or commands, no matter which of the two parties it's forwarding for.

```text
plaintext → encrypt on phone → relay / WebRTC / nearby transport → decrypt on laptop
```

**Message authentication.** Every envelope is signed, so the receiver can verify who sent it, that it wasn't modified in transit, that it belongs to the right workspace, and whether it's already been seen:

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
  ratchetPublicKeyB64: string;
  messageNumber: number;
  previousChainLength: number;
  ciphertext: Uint8Array;
  signature: Uint8Array;
}
```

**Replay protection.** Unique message IDs, sequence numbers, expirations, and seen-message tracking mean an old command or message can't simply be resent later and re-applied — increasingly important as more of the tunnel carries structured commands rather than just notes.

**Forward secrecy.** Each device pair runs its own Double Ratchet session — a fresh, single-use key per message, derived from a chain that steps forward with every exchange. A session bootstraps from each device's long-term identity key plus the pairing secret exchanged over the QR channel, so a relay that substitutes identity keys in transit still can't derive the session without that out-of-band secret. The session heals to fresh ephemeral key material after one round trip: a compromise of a device's current key doesn't expose messages already sent, and doesn't expose anything the pair exchanges going forward. Sessions are strictly pairwise, so revoking one device never requires rekeying anyone else's conversation.

---

## Direct, relayed, and store-and-forward modes

**Direct.** Devices talk peer-to-peer over WebRTC. Lower latency, no server in the payload path, best for local transfer and larger files — though peer-to-peer still reveals network-level metadata to the other party, encryption or not.

```text
Phone ─────────── Laptop
       WebRTC
```

**Relayed.** A server forwards encrypted packets when direct connection fails — different networks, restrictive NAT, a device that's mid-reconnect.

```text
Phone → Relay → Laptop
```

The relay can still see metadata it never needed for content — device identifiers, message size, timing, source IP, destination workspace. Payload encryption protects content; it doesn't erase metadata.

**Store-and-forward.** The tunnel doesn't require both ends to be online at once. A message can sit encrypted — on the sender's device, on the relay's offline queue, or carried by a third trusted device that happens to encounter the true destination first — and still arrive once a path opens, without a live connection ever existing between sender and receiver.

```text
Phone
  ↓ encrypted bundle
Relay, or a trusted device that later meets the destination
  ↓ eventually
Laptop
```

This is the meaningful departure from ordinary secure messaging: most systems assume a session; this one assumes devices meet each other intermittently, and treats that as the normal case rather than a failure mode.

---

## What this is not

ScreenMesh is not a VPN, not a Tor-style anonymous network, not a general TCP tunnel, not a remote-desktop protocol, and not a zero-metadata messaging system. A VPN tunnels arbitrary traffic — browser, git, SSH, database, anything. ScreenMesh tunnels only its own structured objects:

```text
Browser, git, SSH, database, any application     Notes, files, clipboard, commands, workspace events
                ↓                                                    ↓
            VPN tunnel                                  ScreenMesh secure channel
```

The accurate framing: **a secure cross-device handoff channel, purpose-built for one kind of traffic, not a general-purpose network.**

---

## What the secure channel already unlocks

Once devices share a trusted, encrypted channel, capabilities beyond plain notes fall out of it almost for free:

**Secure file drop** — files move directly between trusted devices, chunked transparently above a size threshold, never resting in plaintext on any server.

**Temporary clipboard tunnel** — copy on one device, make it available on another for a set window, then it's gone. No separate mechanism: this composes directly from expiring objects plus delete-after-opening.

**Developer command channel** — a command sent from phone to laptop arrives as a card, not an execution:

```text
Incoming command from Nidhi's Phone

pnpm run integration-test

[Reject] [Copy] [Run]
```

Nothing runs without an explicit, interactive approval on the receiving end.

**Structured agent-to-agent tasks** — an agent on one device can hand a structured request to an agent on another (`{action, params}` against a small, deliberately closed handler registry, not an open plugin surface), behind the same approval gate as any other command, replying with an ordinary object.

**Temporary trusted sessions** — pair into a short-lived workspace on a shared or borrowed machine, move what's needed, and let the workspace expire on its own rather than requiring a manual teardown.

**Capability-based routing** — devices advertise what they can do (a terminal, a filesystem, a camera, a local model), and a send can target "whichever device currently has X" instead of naming one explicitly. This is a routing convenience among devices that are already paired and already trusted — not a privilege boundary, and it shouldn't be treated as one. A device's advertised capability is self-reported, not independently verified.

None of the above required inventing a new trust model. They're all the same encrypted channel, aimed at a different kind of payload.

---

## Where this actually goes next

The tunnel described above is deliberately narrow in a few places — narrow on purpose, not by oversight. These are the real open directions:

**Multi-device group sessions.** Sessions today are strictly pairwise. A protocol like MLS would let a workspace with many devices maintain one group-forward-secret session instead of N pairwise ones — worth revisiting once workspace sizes stop being small enough that pairwise sessions are simply the cheaper, simpler choice.

**A published prekey bundle.** The current bootstrap is an "X3DH-lite": both sides seed their ratchet with long-term identity keys rather than fresh one-time prekeys, because a real one-time-prekey bundle needs server-side infrastructure that doesn't exist yet. A full X3DH would remove the small forward-secrecy gap that exists before a session's first round trip completes.

**Spatial targeting.** UWB or Bluetooth Channel Sounding could let a user point a phone at a laptop to select it, with the actual payload still moving over whatever transport is already negotiated — targeting and transport staying cleanly separated.

**Optical and acoustic bootstrap, taken further.** An animated QR or a screen-camera link could carry pairing material without typing anything or granting Bluetooth permission; the near-ultrasonic transport that already exists could grow the same "bootstrap over one channel, transfer over a faster one" pattern instead of carrying real payloads itself.

**Metadata-hardening on the relay.** The relay already never sees plaintext; hiding message size, timing, and sender/recipient identity from it too is a meaningfully harder, and still open, problem.

**A genuinely capability-verified routing layer.** Today's capability advertisement is trust-on-claim. A version that lets the requesting device confirm a capability actually exists before routing to it would turn a convenience into something closer to a real permission system.

None of these are required to make the tunnel work — they're the directions that would make it work further, wider, or with fewer assumptions than it currently makes.
