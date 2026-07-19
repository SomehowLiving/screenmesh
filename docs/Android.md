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

## Scope: protocol/crypto port first, then a real toolchain

Building a real Android app needs a JDK, the Android SDK, and Gradle —
**none of that was available when this module was started** (no `java`,
no `gradlew`/`gradle`, no `adb`, no `$ANDROID_HOME`). The scope chosen in
response was to write the pure-Kotlin core with no Android-API dependency
first (data model, envelope sealing/verification, the Double Ratchet,
the relay WebSocket + pairing HTTP client), reviewed-by-eye against the
TypeScript source rather than compiled.

**That tooling gap has since been closed.** A JDK (Temurin 17), the
Android SDK (platform 34, build-tools 34.0.0, platform-tools), and
Gradle were installed directly in this environment, and the project now
has a committed Gradle wrapper (`gradlew`/`gradlew.bat`) so anyone else
can build it the same way without a manual toolchain install. `gradlew
compileDebugKotlin`, `gradlew assembleDebug`, and `gradlew lintDebug` all
pass — see "Verification status" for exactly what that does and doesn't
prove.

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
  Yjs-for-Kotlin port exists. Investigated before deferring: the Yjs
  project itself only points at [y-crdt/ykt](https://github.com/y-crdt/ykt)
  (Kotlin bindings for `yrs`, the Rust port of Yjs) and community JNA
  bindings — both require compiling a native Rust library and cross
  -compiling it for every Android ABI via the NDK, which is a whole
  additional toolchain (`rustc`, `cargo`, `cargo-ndk`) this pass didn't
  set up, on top of everything else. A from-scratch reimplementation of
  Yjs's binary update format and YATA merge algorithm was also considered
  and rejected as too large and too easy to get subtly, silently
  incompatible without a way to round-trip test against real Yjs. Net
  effect: Android can create/receive/last-write-wins-update editable
  objects (`text`/`code`/`link`) same as anything else, it just doesn't
  merge concurrent edits via CRDT — a `YJS_UPDATE` from a TS peer editing
  collaboratively is silently ignored, so Android's copy of that object
  can drift from what TS peers see until the next `UPDATE_OBJECT`/
  `CREATE_OBJECT`.
- **`PIN_OBJECT`, `MOVE_OBJECT`, `ADD_ATTACHMENT`** — these have no
  sender-side method in the TS engine either (reserved for a future UI
  action there too), so there's nothing to port yet beyond the
  already-complete wire type in `Operations.kt`.

**Secure file drop chunking** (`FILE_CHUNK`, `sendFileChunks`) IS
implemented: `sendObject` detects a `file`/`image` object whose
`dataB64` exceeds `FILE_CHUNK_SIZE_B64` (200,000 chars ≈ 150 KB raw) and
splits it into a sequence of small `FILE_CHUNK` envelopes instead of one
giant one, each independently carry-eligible; the receive path
reassembles via an in-memory `incomingChunks` map (also not persisted —
a reload mid-transfer loses partial progress and needs a re-send, same
as the TS engine).

### Nearby transports and the BLE pairing bootstrap

`transport/nearby/{BleTransport,WifiDirectTransport,NfcPairing}.kt` are
real implementations, not stubs:

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
  socket. **Not wired into `MainActivity`** — the `WifiP2pManager`
  `BroadcastReceiver` (`WIFI_P2P_PEERS_CHANGED_ACTION`/
  `WIFI_P2P_CONNECTION_CHANGED_ACTION`) that would drive
  `refreshPeers()`/`onGroupOwnerAddressKnown()` doesn't exist yet.
- **`NfcPairing`** is a set of pure helper functions (not a
  `MeshTransport` — NFC is pairing-only, far too low-bandwidth for
  envelope traffic), matching docs/Roadmap.md Phase 3's "NFC tap-to-pair
  via passive tags" design rather than the deprecated phone-to-phone
  Android Beam: write a pairing code onto a blank/rewritable NDEF tag,
  read it back on tap. **Not wired into `MainActivity`** — its
  `enableForegroundDispatch()`/`disableForegroundDispatch()` need
  `onResume`/`onPause` hooks that don't exist yet.

**BLE nearby pairing bootstrap — wired into `MainActivity`.** Rather than
invent a new trust protocol for BLE, `BleTransport` serves an extra
read-only GATT characteristic (`localPairingCode`) carrying the EXACT
SAME "SM1.…" string a QR code or NFC tag already carries. `MainActivity`
now has two buttons exercising this end to end:
- **Scan nearby**: requests BLE runtime permissions if needed, starts
  `BleTransport`, and on the first nearby ScreenMesh peer found, reads
  its pairing characteristic and pre-fills the pairing-code field —
  exactly as if that code had been scanned from a QR.
- **Advertise via BLE**: mints a fresh single-use pairing token via a new
  `rotatePairingTokenHttp` call (owner-only, mirrors the web app's own
  invite action — POST `/workspaces/:id/pairing-token`), builds and
  encodes a `PairingPayload` with it, and offers the resulting code over
  BLE for 5 minutes.

None of the actual trust/crypto logic is new here — BLE only ever moves
the same string every other pairing channel moves, then falls through to
the ordinary `decodePairingPayload` + `joinWorkspaceHttp` flow. A review
pass caught a real race in the first version of this: `onPeerDiscovered`
and `requestPairingCode` could both call `connectToPeripheral` for the
same newly-found device, opening two concurrent GATT connections:
`connectToPeripheral` is now idempotent per device address
(`connectingAddresses`), fixed before this landed.

## Setup

The project has a committed Gradle wrapper, so a command-line build needs
only a JDK 17+ and the Android SDK (`ANDROID_HOME`/`local.properties`
pointing at it): `./gradlew assembleDebug` from `apps/android`. For actual
day-to-day development:

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

**What IS now verified, with a real toolchain (Temurin JDK 17, Android
SDK platform 34 + build-tools 34.0.0, Gradle 8.7):**
- `./gradlew compileDebugKotlin` — the entire Kotlin module compiles
  clean (only pre-existing, accepted deprecation warnings on the legacy
  BLE GATT read/write overloads — see `BleTransport.kt`'s doc comment).
- `./gradlew assembleDebug` — produces a real, installable
  `app-debug.apk` (~9.7 MB).
- `./gradlew lintDebug` — passes (only cosmetic warnings expected of a
  bare reference UI: hardcoded strings instead of `strings.xml`
  resources, a missing launcher icon, missing autofill hints — no
  correctness issues).
- The Gradle wrapper itself was exercised standalone (`./gradlew.bat
  compileDebugKotlin` with nothing but `JAVA_HOME` and `ANDROID_HOME`
  set) and reproduced the same result, confirming the build doesn't
  secretly depend on some other piece of this machine's setup.

This verification pass had real teeth — it caught two genuine bugs no
amount of reading would have: a Kotlin visibility error
(`RatchetSession.skippedKeys` was `internal` but exposed a
`private`-in-file `SkippedKey` type — Ratchet.kt — fixed by making
`SkippedKey` `internal` instead of widening the property, since
`skippedKeys` is read from top-level functions in the same file that a
class-`private` property can't reach), and an Android lint error
(`ACCESS_FINE_LOCATION` declared without the now-mandatory
`ACCESS_COARSE_LOCATION` alongside it on API 31+ — `CoarseFineLocation`
— fixed in `AndroidManifest.xml`).

**What is still NOT verified — no device or emulator exists in this
environment:**
- The app has never actually **run**. Compiling and lint-checking prove
  the Kotlin/manifest/resource shapes are internally consistent; they
  prove nothing about runtime behavior.
- **Cross-language wire compatibility is still unconfirmed.** The
  single biggest risk named throughout this doc — a subtly wrong base64
  alphabet, a reordered signed-bytes field, an HKDF info-string typo —
  would compile and lint clean and still silently fail the moment a real
  Android phone and a real browser try to talk to each other over a live
  relay. That first real interop run is still the next thing to do
  before relying on this for anything real.
- The BLE/Wi-Fi Direct/NFC code has never touched real Bluetooth/Wi-Fi
  Direct/NFC radios — compiling against the Android SDK's API surface
  confirms the calls are *shaped* correctly, not that the runtime
  behavior (GATT callback timing, MTU negotiation, characteristic
  read/write races) is correct.
- No unit or instrumented tests exist for this module.
