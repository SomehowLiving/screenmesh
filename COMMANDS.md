# Commands

Quick reference for running and testing ScreenMesh locally — the web PWA,
the relay server, the desktop agent, and the Android app — plus a
feature-by-feature map of how to exercise everything that's been built.
Run everything from the repo root unless noted. Requirements: **Node.js
≥ 20**, **pnpm ≥ 9**.

## Setup

```bash
pnpm install
```

## Run the backend (relay server)

```bash
pnpm dev:server
```

Starts the Fastify relay on **http://localhost:8787** (watch mode via
`tsx watch` — restarts on file changes). Health check:
`http://localhost:8787/api/health`. Everything else in this doc — the
PWA, the desktop agent, the Android app, and every test script — needs
this running first.

## Run the frontend (PWA)

```bash
pnpm dev:web
```

Starts the Vite dev server on **https://localhost:5173** (self-signed
HTTPS — required for Web Crypto; accept the browser warning once).
Listens on all interfaces (`host: true`) so phones on the same Wi-Fi can
reach it, and proxies `/api` to the relay server same-origin.

**Run both**: open two terminals, one per command above. `dev:server`
must be running before `dev:web` can pair/sync.

## Run the desktop agent

A browser tab can't spawn a shell, so approval-gated command execution
runs as a separate local process (`apps/agent`), reusing the exact same
crypto/sync/transport packages as the PWA:

```bash
# Pair it — grab a "Copy join link" from the web app's pairing panel first
pnpm --filter @screenmesh/agent dev -- --join "<join-link-or-code>" --name "My Desktop"

# Later runs resume the saved session automatically (state saved to
# ~/.screenmesh-agent.json, or $SCREENMESH_AGENT_STATE)
pnpm dev:agent
```

It advertises the `terminal` capability, so the web app's Send panel can
route to it directly ("send to whichever device has a terminal"). Send
it a `command` or `agent_task` object and it prints what's being asked
and waits for `[R]un` before executing anything — see
[docs/Security.md §8](docs/Security.md#8-command-safety).

## Run the Android app

`apps/android` is a from-scratch Kotlin port of the protocol/crypto/sync
stack — see [docs/Android.md](docs/Android.md) for the full design
notes and exactly what's verified vs. not. It has a committed Gradle
wrapper, so building it needs only a JDK 17+ and the Android SDK.

```bash
cd apps/android

# Windows
.\gradlew.bat assembleDebug

# macOS/Linux
./gradlew assembleDebug
```

Produces `apps/android/app/build/outputs/apk/debug/app-debug.apk`. Other
useful targets: `compileDebugKotlin` (fast compile-only check),
`lintDebug` (Android lint), `printRuntimeClasspath` (prints the
plain-JVM dependency classpath, used by the interop test below).

**Install it** on a device or emulator: `adb install -r app-debug.apk`,
then launch the `ScreenMesh` app. The relay server URL field defaults to
`http://10.0.2.2:8787/api` (the Android emulator's alias for the host
machine's `localhost`); on a real device, use your machine's LAN IP
instead (same one the web app's join link uses).

**Mint a pairing code from the command line** (no web app needed) to
paste into the Android app's "Pairing code" field:

```bash
pnpm exec tsx packages/sync/scripts/mint-pairing-code.ts [workspace-name]
```

Prints an `SM1.…` code to stdout after creating a throwaway workspace
against the relay server on `127.0.0.1:8787`.

## Pairing a second device (e.g. your phone)

1. `dev:server` and `dev:web` both running.
2. On the laptop, open `https://localhost:5173`, create a workspace.
3. The QR / join link auto-detects your machine's LAN IP (via
   `/api/info`) so other devices can reach it.
4. Scan with the phone (same Wi-Fi network). Accept the certificate
   warning (self-signed dev cert).

If the phone can't connect: check Windows Firewall is allowing Node on
ports `5173` and `8787` (private network).

## Two "devices" in one browser (no phone needed)

```
https://localhost:5173/?device=2
```

The `device` query param gives that tab its own local identity/database,
separate from the default tab.

## Type-check everything

```bash
pnpm typecheck
```

Covers every TypeScript package/app (`packages/*`, `apps/web`,
`apps/server`, `apps/agent`). Does **not** cover `apps/android` (Kotlin,
type-checked via Gradle instead — see above).

## Build everything

```bash
pnpm build
```

## Run the unit tests

```bash
pnpm test
```

Runs every workspace package's vitest suite (`packages/crypto`,
`packages/protocol` — 46 tests as of this writing): base64 round-trips,
Ed25519/X25519 identity, AES-GCM encrypt/decrypt, the Double Ratchet
(root key agreement, healing after one round trip, out-of-order delivery,
replay rejection), envelope seal/verify/decrypt, and pairing-code
encode/decode. No relay server or network access needed — these are pure
unit tests. `apps/android` has a Kotlin-mirrored equivalent (45 tests) —
see "Android: JVM unit tests" below.

## Run the automated smoke tests

Requires `dev:server` running first (scripts hit `127.0.0.1:8787`).

```bash
pnpm smoke
```

Runs, in order:

1. **`packages/crypto/scripts/ratchet-test.ts`** — standalone Double
   Ratchet correctness (out-of-order delivery, skipped-key recovery),
   independent of the relay/engine.
2. **`packages/sync/scripts/smoke.ts`** — relay auth, live envelope
   delivery, and store-and-forward for an offline recipient.
3. **`packages/sync/scripts/engine-smoke.ts`** — the full `MeshEngine`
   feature surface end to end (19 steps): objects/deliveries, images,
   checklists, Yjs concurrent-edit merge, continue-on-device, expiring
   objects, `deleteAfterOpening`, `requireConfirmation` accept/reject,
   store-carry-forward through a third device, chunked secure file drop,
   the clipboard tunnel, capability routing, and device revocation
   (with proof that revoking one device never touches another pair's
   ratchet session).
4. **`apps/agent/scripts/agent-smoke.ts`** — the desktop agent joining
   via the real `join.ts` logic and exchanging `command`/`agent_task`
   objects through the approval gate (non-interactive stand-in for the
   CLI's prompt).

## Android: JVM unit tests (no device/emulator needed)

Kotlin mirrors of `packages/crypto`/`packages/protocol`'s vitest suites —
base64, identity, AES-GCM, the Double Ratchet (including out-of-order
delivery and replay rejection), envelope seal/verify/decrypt, and
pairing-code encode/decode. Runs straight on the JVM, no emulator needed
(these files have no Android API dependency).

```bash
cd apps/android && ./gradlew testDebugUnitTest
```

## Android: cross-language interop test (no device/emulator needed)

Proves the Kotlin port actually speaks the same protocol as the
TypeScript engine — see
[docs/Android.md § Cross-language wire compatibility](docs/Android.md).
One command runs both sides (starts the relay if one isn't already
running, compiles the Kotlin module, assembles its plain-JVM classpath,
and runs the TS and Kotlin sides against each other):

```bash
pnpm test:interop
```

Both sides print a final `ANDROID INTEROP OK` / `KOTLIN INTEROP OK` on
success. Under the hood (`apps/android/scripts/run-interop-test.mjs`):
compile the Android module and print its plain-JVM runtime classpath via
`./gradlew compileDebugKotlin printRuntimeClasspath`, run the TypeScript
side (`packages/sync/scripts/interop-with-android.ts`) to create a
workspace and write a handoff file, then run the Kotlin side
(`com.screenmesh.InteropSmokeKt`) with a `java -cp` built from the
compiled classes dir plus the non-Android `.jar` entries from the printed
classpath (`.aar` entries are Android-packaging-only and unused by the
plain-Kotlin protocol/crypto/transport/sync code this exercises).

## Android: acoustic PHY loopback test (no device/emulator needed)

Drives the real vendored acoustic modem's DSP core
(`AcousticPhyLink.encode()`/`.ingest()` — OFDM/D-CSS modulation, preamble
sync) through a simulated noisy channel and confirms round-trip byte
correctness — see
[docs/Android.md's acoustic transport section](docs/Android.md) for what
this does and doesn't prove (no real microphone/speaker involved).

```bash
pnpm test:acoustic-loopback
```

## Android: real-device / emulator testing

With an emulator or physical device running and the app installed (see
"Run the Android app" above):

1. Mint a pairing code: `pnpm exec tsx packages/sync/scripts/mint-pairing-code.ts`.
2. Paste it into the app, tap **Join workspace**.
3. Type a message, tap **Send to all** — appears in the sender's log on
   any other joined device (web, agent, or another Android instance).
4. **Scan nearby** / **Advertise via BLE** / **Write to NFC tag** / **Scan
   nearby (Wi-Fi Direct)** exercise the nearby-pairing bootstraps — real
   BLE/NFC/Wi-Fi Direct radio hardware is required for these to actually
   find a peer (an emulator has none), but they should request runtime
   permissions correctly and never crash regardless.
5. **Forget device** clears local identity/session (does not revoke
   server-side — use the web app's revoke action for that).

Relaunching the app should auto-reconnect via the saved session without
a new pairing code (a pairing token is single-use).

## Per-package scripts

Run from repo root with `pnpm --filter <package> <script>`, e.g.:

```bash
pnpm --filter @screenmesh/web build      # production build (dist/)
pnpm --filter @screenmesh/web preview    # preview the production build
pnpm --filter @screenmesh/server start   # run server without watch mode
```

## Feature reference: what to run to see each feature

| Feature | Where it lives | How to see/test it |
|---|---|---|
| QR / join-link device pairing | `packages/crypto` pairing codec, web pairing panel | Web: create a workspace, scan the QR. Agent: `--join "<link>"`. Android: paste the `SM1.…` code or use `mint-pairing-code.ts`. |
| Nearby pairing over BLE/NFC | `apps/android/.../transport/nearby` | Android app's **Scan nearby** / **Advertise via BLE** / **Write to NFC tag** buttons (needs real radio hardware to actually find a peer). |
| Wi-Fi Direct (raw transport, not pairing) | `apps/android/.../transport/nearby/WifiDirectTransport.kt` | Android app's **Scan nearby (Wi-Fi Direct)** button — discovers/connects to peers; no envelope routing wired to it yet, see docs/Android.md. |
| Send text/links/code/images/files/checklists | `MeshEngine.sendObject` | Web app's compose panel; Android app's message field (text only in the reference UI). |
| Delivery lifecycle (queued→sending→delivered→opened) | `packages/sync` | Web device dashboard; `engine-smoke.ts` steps 3–5. |
| Offline queueing / store-and-forward | Relay + client outbox | `smoke.ts` step 4 (disconnect, send, reconnect). |
| Store-carry-forward (a third device relays a bundle) | `MeshEngine` outbox/carried maps | `engine-smoke.ts` step 14. |
| Expiring objects / `deleteAfterOpening` / `requireConfirmation` | `packages/sync` delivery options | `engine-smoke.ts` steps 10–13; web app's send options. |
| CRDT collaborative text editing (Yjs) | `packages/sync` (`editText`) | `engine-smoke.ts` step 8. **Not ported to Android** — see docs/Android.md. |
| Secure file drop (chunked large files) | `MeshEngine` `FILE_CHUNK` | `engine-smoke.ts` step 15; ported to Android's `MeshEngine.kt` too. |
| Temporary clipboard tunnel | `MeshEngine` (expiring + delete-after-opening) | `engine-smoke.ts` step 16. |
| Capability routing (`resolveCapability`) | `MeshEngine` | `engine-smoke.ts` step 17; desktop agent advertises `terminal`. |
| Device revocation (per-pair ratchet, no group rekey) | `packages/sync` + relay | `engine-smoke.ts` steps 18–19. |
| Command / agent-task execution (approval-gated) | `apps/agent` | `agent-smoke.ts`; real CLI via `pnpm dev:agent`. |
| Double Ratchet forward secrecy | `packages/crypto/src/ratchet.ts` | `ratchet-test.ts`; exercised implicitly by every other test above. |
| Cross-language (TS ↔ Kotlin) wire compatibility | — | `interop-with-android.ts` + `InteropSmoke.kt` (see above). |

For the underlying design of any of these, see
[docs/Architecture.md](docs/Architecture.md),
[docs/Security.md](docs/Security.md),
[docs/Transports.md](docs/Transports.md),
[docs/Roadmap.md](docs/Roadmap.md), and
[docs/Android.md](docs/Android.md).
