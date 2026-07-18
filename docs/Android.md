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
| BLE transport (real, unwired) | `transport/nearby/BleTransport.kt` | (new — no TS equivalent exists) |
| Wi-Fi Direct transport (real, unwired) | `transport/nearby/WifiDirectTransport.kt` | (new — no TS equivalent exists) |
| NFC pairing helper (real, unwired) | `transport/nearby/NfcPairing.kt` | (new — no TS equivalent exists) |
| Pairing HTTP client | `sync/PairingClient.kt` | `apps/agent/src/join.ts` + `apps/server/src/workspaces.ts` |
| Identity/session persistence | `sync/LocalState.kt` | `packages/crypto/src/persist.ts` + `apps/agent/src/state.ts` |
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
`acceptObject` / `rejectObject`, `updateObjectContent` (plain
last-write-wins, no Yjs), `continueOnDevice`, `revokeDevice`,
`resolveCapability`, presence sync, **store-carry-forward** (in-memory
outbox/carried maps, a reentrancy-guarded `periodicSweep` on a
`ScheduledExecutorService`, `CARRY_BUNDLE` handling, hop-limited carrier
offers), and the verify → ratchet-decrypt → apply receive path for
`CREATE_OBJECT`, `UPDATE_OBJECT`, `DELETE_OBJECT`, `CONTINUE_ON_DEVICE`,
`SEND_TO_DEVICE`, `MARK_DELIVERED`, `MARK_OPENED`, `REJECT_OBJECT`,
`CARRY_BUNDLE`, `REVOKE_DEVICE`.

**Object/delivery/ratchet-session persistence** is still in-memory only
(`ConcurrentHashMap`s) — there is no Android storage layer
(`packages/storage`'s Dexie/IndexedDB has no equivalent here; a Room
database would be the natural fit). Restarting the app loses every
object, delivery, and in-memory ratchet session (a lost ratchet session
just re-bootstraps from identity + pairing secret on the first message,
exactly as the ratchet design intends — docs/Security.md §5). This is
**not a regression versus the desktop agent** — `apps/agent` keeps the
exact same scope for the exact same reason (see its `state.ts` doc
comment); only identity + session survive a restart on either platform.
`sync/LocalState.kt` is what persists that narrower thing on Android.

**Explicitly NOT ported** (unimplemented ops are silently ignored,
matching the TS engine's `default: break` — a scope line, not a bug):
- **Yjs collaborative text editing** (`YJS_UPDATE`, `editText`). No
  Yjs-for-Kotlin port exists; would need either a JVM CRDT library or a
  from-scratch wire-compatible Yjs update decoder — a large undertaking
  on its own, not attempted here.
- **Secure file drop chunking** (`FILE_CHUNK`, `sendFileChunks`).
- **`PIN_OBJECT`, `MOVE_OBJECT`, `ADD_ATTACHMENT`** — these have no
  sender-side method in the TS engine either (reserved for a future UI
  action there too), so there's nothing to port yet beyond the
  already-complete wire type in `Operations.kt`.

### Nearby transports: implemented, still unwired into MainActivity

`transport/nearby/{BleTransport,WifiDirectTransport,NfcPairing}.kt` are
now real implementations, not stubs:

- **`BleTransport`** implements `MeshTransport` fully: this device is
  simultaneously a GATT peripheral (advertises a ScreenMesh service +
  characteristic) and a GATT central (scans for and connects to the same
  service on other phones). Each SecureEnvelope JSON blob is framed with
  a 4-byte length header and reassembled on the other end; messages
  larger than one negotiated MTU (~517 bytes after `requestMtu`) are NOT
  fragmented across multiple writes — fine for pairing codes and short
  text objects, not bulk transfer.
- **`WifiDirectTransport`** implements `MeshTransport` fully: discovers
  peers via `WifiP2pManager`, and once a group forms, carries
  length-prefixed envelope bytes over a plain TCP socket between the
  group owner and the client. No MTU concerns here — it's a normal
  socket.
- **`NfcPairing`** is a set of pure helper functions (not a
  `MeshTransport` — NFC is pairing-only, far too low-bandwidth for
  envelope traffic), matching docs/Roadmap.md Phase 3's "NFC tap-to-pair
  via passive tags" design rather than the deprecated phone-to-phone
  Android Beam: write a pairing code onto a blank/rewritable NDEF tag,
  read it back on tap. `MainActivity` doesn't call these yet (see below).

**What's still missing before these are usable from the app:**
- **Runtime permission requests.** The manifest declares everything
  needed (`BLUETOOTH_SCAN`/`ADVERTISE`/`CONNECT`, `NEARBY_WIFI_DEVICES`,
  `ACCESS_FINE_LOCATION` below API 33, `NFC`), but Android's runtime
  permission dialogs (`ActivityResultContracts.RequestMultiplePermissions`)
  are not wired into `MainActivity` — each transport's doc comment says
  so explicitly ("caller is responsible for requesting permissions
  first").
- **`MainActivity` doesn't instantiate or call any of the three.** It
  only uses `RelayTransport`. Wiring a nearby transport in means: request
  permissions, construct the transport, register the
  `WifiP2pManager`/NFC `BroadcastReceiver`s (`WifiDirectTransport` and
  `NfcPairing` both expose the hooks a hosting Activity needs —
  `refreshPeers()`/`onGroupOwnerAddressKnown()` and
  `enableForegroundDispatch()`/`disableForegroundDispatch()` respectively
  — but don't register the receivers themselves), and decide how a
  nearby-discovered peer maps to a `MeshEngine` ratchet session (today
  `MeshEngine` only knows relay-learned `deviceId`s from presence; a BLE
  MAC address or Wi-Fi Direct device address isn't one of those without
  an explicit pairing handshake over the nearby channel first).
- This last point is the real remaining design gap, not just missing
  glue code: pairing over BLE/Wi-Fi Direct/NFC needs its own bootstrap
  (something has to carry a `PairingPayload` over the nearby channel the
  way the QR code does today) before a nearby-discovered peer can join a
  `MeshEngine` session at all.

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
6. Relaunching the app should reconnect automatically (it persists
   identity + session — see `sync/LocalState.kt`) without needing a new
   pairing code, since a pairing token is single-use. **Forget device**
   clears that saved state locally (it does not revoke the device
   server-side — use the web app's revoke action for that).

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
