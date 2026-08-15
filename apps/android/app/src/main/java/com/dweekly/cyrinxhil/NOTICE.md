# Vendored: Cyrinx (acoustic modem)

The Kotlin files in this package (`com.dweekly.cyrinxhil`) are vendored
from [dweekly/cyrinx](https://github.com/dweekly/cyrinx)
(`Apps/HIL/android/app/src/main/java/com/dweekly/cyrinxhil/`), commit
`123a105e7714d96e5650c9d6c02db7ffb7dae007` (2026-07-27). All but two
files below are **verbatim, unmodified**; the two exceptions are called
out explicitly with the reason:

- `CyrinxProtocol.kt` — shared status codes, enums, config/message data
  classes, and the `FrameTxSink` interface. Verbatim.
- `CyrinxTransportSession.kt` — the half-duplex ping-pong link/session
  state machine (start/stop/send/receive/ingestFrame), independent of any
  specific audio backend. Verbatim.
- `AndroidAudioBackend.kt` — the real `AudioRecord`/`AudioTrack` I/O loop;
  implements `FrameTxSink` and feeds captured, demodulated frames back
  into the session via a callback. **Modified**: added
  `@SuppressLint("MissingPermission")` on `start()` (plus the
  corresponding import) — Android Lint's `MissingPermission` check
  otherwise fails the build on the `AudioRecord(...)` construction here,
  since `RECORD_AUDIO` is a runtime-requested permission. Matches the
  exact same pattern already used in `BleTransport.kt`/
  `WifiDirectTransport.kt`: the caller (`AcousticTransport.start()`) is
  responsible for requesting the permission before calling this, same as
  every other transport in this codebase. No behavioral change.
- `AcousticPhyLink.kt` — the actual DSP: OFDM/D-CSS modulation and
  demodulation, preamble sync, channel estimation. **Modified**: one
  local variable declaration (`var frame = bodyPayload`) was moved to
  after its preceding null-check guard, with an explicit non-null
  `ByteArray` type annotation, because this project's Kotlin compiler
  version doesn't smart-cast a separate `var` from the smart-cast
  performed on the variable it was assigned from. Same value, same
  control-flow path, purely a reordering — see the inline comment at the
  change site for detail.
- `FFT.kt` — a small in-place radix-2 Cooley-Tukey FFT used by the PHY.
  Verbatim.
- `X25519.kt` — cyrinx's own optional end-to-end envelope encryption.
  Verbatim. Vendored only because `AcousticPhyLink.kt` references it as
  a same-package class (Kotlin same-package visibility needs no
  `import`, so this dependency doesn't show up in an `import`-only
  grep) — not because its crypto path is actually used: `SessionConfig`
  is always constructed here with `enableCrypto = false` (see
  `AcousticTransport.kt`), so `X25519`'s logic never runs. Kept for
  compilation only.

These implement a real (not simulated) acoustic ultrasonic/near-ultrasonic
data link for Android — this is the piece `apps/android`'s new
`transport/nearby/AcousticTransport.kt` (ScreenMesh's own code, NOT
vendored) wraps to conform to `MeshTransport`, matching how `BleTransport`/
`WifiDirectTransport` wrap `android.bluetooth`/`android.net.wifi.p2p`.

**Why vendor rather than depend on the upstream Swift package**: cyrinx's
canonical implementation is a Swift/C package restricted to
`.macOS(.v13)`/`.iOS(.v17)` (see its `Package.swift`) — no Android or
Linux target, and no Swift toolchain exists in the environment this was
integrated in anyway. Its own README states Android JNI and
transport-API integration "remain pending" upstream, and its Android
Chat app's `ChatTransportClient` is currently backed only by
`SimulatedChatTransportClient` — the "live Cyrinx 3 SDK adapter" for
Android doesn't exist yet even in the source project. This pure-Kotlin
HIL (hardware-in-loop test) implementation, by contrast, has no
Swift/JNI/native dependency at all — it's a real, self-contained Android
audio-DSP implementation, just not (yet) the one wired into cyrinx's own
production Chat app.

**Not vendored** (deliberately out of scope): `BulkDemod.kt` (a separate,
higher-throughput wideband codec `AcousticPhyLink`/`AndroidAudioBackend`
don't call), and the tone/OOK/Morse/DTMF/reverse-burst codecs (alternate
low-rate PHYs not used by `AcousticPhyLink`/`AndroidAudioBackend`'s
default configuration). `X25519.kt` IS vendored (see above) but its
crypto path is never invoked at runtime — every byte this transport
carries is already a ScreenMesh `SecureEnvelope`, encrypted and signed at
a layer above; layering a second, independent crypto scheme underneath
would add complexity without a security benefit and risks masking bugs
across two overlapping trust boundaries, hence `enableCrypto = false`.

**License**: Apache License 2.0, Copyright 2026 Primatech Paper Co LLC
(David E. Weekly) and contributors. See the repo root
[`NOTICE`](../../../../../../../../../NOTICE) file and
[`LICENSE`](../../../../../../../../../../LICENSE) for the full text and
ScreenMesh's own copyright — this subdirectory's code is governed by
cyrinx's Apache-2.0 license, unmodified from upstream.

**Verification status**: compiles as part of `apps/android`'s normal
Gradle build (this is plain Kotlin + Android SDK APIs, no native/JNI
step) — see docs/Android.md. The actual acoustic link has NOT been
tested over real air on real hardware in this environment.
