# ScreenMesh Android

A native Kotlin app under `apps/android` that speaks the same Device Bus
protocol as the web PWA (`apps/web`) and the desktop agent (`apps/agent`):
same envelope format, same Double Ratchet sessions, same relay wire
protocol. The goal is for the phone to be just another node on the mesh,
not a separate system with its own protocol.

## Why a hand port instead of sharing the TypeScript packages

The rest of ScreenMesh (`packages/protocol`, `crypto`, `sync`, `transport`)
is TypeScript, runnable from both the browser and Node (`apps/agent`
reuses those packages directly). Android can't run either — there's no JS
runtime here — so `apps/android` is a manual Kotlin port of the same
wire-level contracts, not a reuse of the existing packages. That makes
byte-for-byte parity the central risk: a subtly wrong base64 alphabet, a
reordered field in a signed byte string, or an HKDF info-string typo would
produce a phone that can *connect* to the relay but silently fail to
decrypt or verify anything from its peers. Every file below has a "Kotlin
mirror of `packages/x/src/y.ts`" doc comment pointing at its source of
truth for exactly this reason — if the TS side changes, grep for that
comment to find what else needs updating.

## Scope of this pass: protocol/crypto port first

Building and testing a real Android app needs a JDK, the Android SDK,
Gradle, and (for anything beyond a compile check) a device or emulator.
**None of that tooling is available in the environment this was written
in** — no `java`, no `gradlew`/`gradle`, no `adb`, no `$ANDROID_HOME`. That
was surfaced up front, and the explicit scope chosen in response was:
write the pure-Kotlin core that has no Android-API dependency (data
model, envelope sealing/verification, the Double Ratchet, the relay
WebSocket + pairing HTTP client), and stub Bluetooth LE / Wi-Fi Direct /
NFC behind interfaces, since those need real hardware to build and test
regardless of what tooling this environment had. **Nothing in
`apps/android` has been compiled or run.** See "Verification status"
below.

## What's implemented

| Layer | File(s) | Mirrors (TS source of truth) |
|---|---|---|
| Wire types | `protocol/Types.kt`, `Operations.kt`, `Bundle.kt`, `Relay.kt` | `packages/protocol/src/{types,operations,bundle,relay}.ts` |
| Envelope shape | `protocol/Envelope.kt` | `packages/protocol/src/envelope.ts` |
| Base64 | `crypto/Base64Util.kt` | `packages/protocol/src/base64.ts` |
| Identity (Ed25519 + X25519) | `crypto/Identity.kt` | `packages/crypto/src/identity.ts` |
| AES-GCM | `crypto/Encrypt.kt` | `packages/crypto/src/encrypt.ts` |
| Double Ratchet | `crypto/Ratchet.kt` | `packages/crypto/src/ratchet.ts` |
| Envelope seal/verify/decrypt | `crypto/SecureEnvelopeCodec.kt` | `packages/crypto/src/envelope.ts` |
| Pairing codec | `crypto/Pairing.kt` | `packages/crypto/src/pairing.ts` |
| Transport interface | `transport/MeshTransport.kt` | `packages/transport/src/transport.ts` |
| Relay WebSocket client | `transport/RelayTransport.kt` | `packages/transport/src/websocket.ts` |
| Pairing HTTP client | `sync/PairingClient.kt` | `apps/agent/src/join.ts` + `apps/server/src/workspaces.ts` |
| Sync engine (reduced — see below) | `sync/MeshEngine.kt` | `packages/sync/src/engine.ts` |
| Reference UI | `MainActivity.kt` + `res/layout/activity_main.xml` | (new; not a port) |

### Crypto primitive choices and why

- **BouncyCastle (`bcprov-jdk18on`) for Ed25519/X25519/HKDF.** Android's
  native `java.security` support for these algorithms only became
  consistent at API 33; this app's `minSdk` is 26, and BouncyCastle's
  lightweight API works identically across that whole range.
- **`javax.crypto` (platform built-in) for AES-GCM.** Unlike Ed25519/X25519,
  AES-GCM has been solid in `javax.crypto.Cipher` since API 1 — no need to
  pull BouncyCastle in for this one.
- **`java.util.Base64` for base64.** Its default (non-MIME) codec is
  byte-for-byte the same standard, padded base64 that `btoa`/`atob`
  produce; available since API 26.
- **OkHttp for both the relay WebSocket and the pairing HTTP POST.**
- **Plain `String`, not Kotlin enums, for wire-format fields**
  (`Device.type`, `.role`, `.capabilities`, `Operation.type`, ...) —
  matching the TS side's deliberate choice to keep these open sets rather
  than closed unions, and avoiding an enum↔string mapping that could
  silently drift from the TS spelling. `TransportKind`/`TransportStatus`
  ARE plain Kotlin enums, because — unlike those wire fields — they are
  purely local, never serialized to JSON, so there's no cross-language
  string to keep in sync.

### MeshEngine.kt: what's ported vs. deferred

`MeshEngine` is the layer tying protocol + crypto + transport together
(UI action → op → seal → send; receive → verify → decrypt → apply). The
Kotlin version is a **reduced** port, not a full one:

**Implemented:** identity-backed pairwise ratchet sessions (get-or-create
per peer), `sendObject` (CREATE_OBJECT + SEND_TO_DEVICE), `markOpened` /
`acceptObject` / `rejectObject`, `revokeDevice`, `resolveCapability`,
presence sync, and the verify → ratchet-decrypt → apply receive path for
six op types: `CREATE_OBJECT`, `SEND_TO_DEVICE`, `MARK_DELIVERED`,
`MARK_OPENED`, `REJECT_OBJECT`, `REVOKE_DEVICE`.

**Explicitly NOT ported this pass** (unimplemented ops are silently
ignored, matching the TS engine's `default: break` — not a bug, a scope
line):
- **Persistence.** Everything lives in `ConcurrentHashMap`s. There is no
  Android storage layer (`packages/storage`'s Dexie/IndexedDB has no
  equivalent here yet — a Room database would be the natural fit).
  Restarting the app loses every object, delivery, and ratchet session.
- **Store-carry-forward** (`packages/sync/src/engine.ts`'s outbox/carried
  tables, `periodicSweep`, `CARRY_BUNDLE`). An undeliverable send is
  dropped, not queued — there's no outbox to drain on reconnect.
- **Yjs collaborative text editing** (`YJS_UPDATE`, `editText`). No Yjs
  port exists for Kotlin.
- **Secure file drop chunking** (`FILE_CHUNK`, `sendFileChunks`).
- **`continueOnDevice` / `CONTINUE_ON_DEVICE`.**
- **`UPDATE_OBJECT`, `DELETE_OBJECT`, `PIN_OBJECT`, `MOVE_OBJECT`,
  `ADD_ATTACHMENT`.**

### Nearby transports: stubbed, not implemented

`transport/nearby/{BleTransport,WifiDirectTransport,NfcPairing}.kt` are
interface-shaped stubs — every method throws `NotImplementedError`. Each
file's doc comment sketches the intended design (GATT service for BLE,
`WifiP2pManager` + a TCP socket for Wi-Fi Direct, NDEF-carried pairing
code for NFC) for whoever picks this up with a real device in hand. None
of the three are wired into `MeshTransport` yet.

## Setup (once you have Android Studio)

1. Open `apps/android` in Android Studio (Giraffe+ recommended); it should
   prompt to install any missing SDK platform/build-tools for
   `compileSdk 34`.
2. Start the relay server from the repo root:
   `pnpm --filter @screenmesh/server exec tsx src/index.ts` (listens on
   `0.0.0.0:8787`, all routes under `/api`).
3. Run the app. In the emulator, `10.2.2.2` doesn't reach your host — use
   `10.0.2.2`, the emulator's alias for the host machine's `localhost`
   (pre-filled in the server URL field as `http://10.0.2.2:8787/api`). On
   a real device, use your machine's LAN IP instead (the same one the web
   app's join link uses — see the `/api/info` endpoint in
   `apps/server/src/index.ts`).
4. Pair from the web app (or desktop agent) as normal, copy the pairing
   code (the `SM1.…` string — the raw code works, not just the QR image),
   paste it into the Android app, tap **Join workspace**.
5. Send a text object from either side and confirm it shows up on the
   other.

## Verification status

**Nothing in `apps/android` has been compiled, type-checked, or run.**
This environment has no JDK, no Android SDK, no Gradle, no `adb`, and no
emulator or device — confirmed via `java -version`, `which gradle`,
`which adb`, `which kotlinc`, and checking `$ANDROID_HOME`/
`$ANDROID_SDK_ROOT`, all before starting this port. Every other layer of
ScreenMesh in this repo (`packages/*`, `apps/web`, `apps/server`,
`apps/agent`) has been verified by actually running it — `pnpm -r
typecheck`, real builds, and smoke tests against a live relay. That
verification discipline could not be applied here, and this file exists
partly to say so plainly rather than let a "Phase 3 done" claim imply
otherwise. Treat every Kotlin file in `apps/android` as reviewed-by-eye
against its TS source, not as tested. The most likely class of latent bug
is a wire-format mismatch (base64 padding, a canonical-signing-bytes field
order slip, an HKDF info string typo) that would only surface the first
time a real phone and a real browser try to talk to each other — that
first real run against a live relay is the next thing to do, ideally
before relying on this for anything real.
