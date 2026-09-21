# Local Companion Audit Verdict — Current State

This document supersedes the route-discovery-only verdict. It describes the
current codebase, not a production certification. The prior architecture audit
remains a historical baseline in
[`ScreenMesh_Before_local_Companion_Audit.md`](ScreenMesh_Before_local_Companion_Audit.md).

## Verdict

**Implemented through secure Local Companion transport, but not released.**

ScreenMesh can establish a temporary Android-to-desktop local route through the
optional Chromium extension and native companion. It is scoped to one
user-selected IPv4 interface, QR-pinned with ephemeral TLS, bootstrapped with a
one-use token, and carries opaque already-encrypted ScreenMesh envelopes.

It is not production-ready because the extension and companion are not yet
packaged/signed/published, the native-host installer flow is absent, and
physical-device Wi-Fi/firewall/VPN validation has not been recorded.

## Current capability matrix

| Capability | Status | Notes |
| --- | --- | --- |
| Route discovery | Implemented | Native host returns non-loopback IPv4 name/address/type metadata only. It recommends private Wi-Fi/Ethernet heuristically. |
| Route selection | Implemented | The owner selects the exact listener address in Pair Device. VPN/virtual routes require an explicit confirmation. |
| Selected-interface listener | Implemented | Random TCP port on the exact selected address; never `0.0.0.0`. |
| TLS bootstrap | Implemented | Fresh TLS 1.2+ certificate, matching IP SAN, and QR-provided SHA-256 SPKI pin. |
| One-use local authorization | Implemented | Separate 128-bit token; native host retains only a SHA-256 hash. The listener expires within five minutes. |
| SM2 invitation | Implemented | QR includes local address/port/pin/session material plus ordinary relay-authorized pairing material. SM1 remains compatible. |
| Android local client | Implemented | Android validates the pin before sending the token and keeps the authenticated TLS socket open. |
| Local envelope transport | Implemented | Opaque `SecureEnvelope` bytes take Local Companion before WebRTC and encrypted relay. |
| Failure fallback | Implemented | Socket, adapter, extension, or host loss removes the LAN peer; WebRTC → relay → outbox remains active. |
| Browser PWA local socket | Deliberately unsupported | Mobile/browser PWA continues with WebRTC/relay because of certificate, mixed-content, CORS, and Private Network Access constraints. |
| Extension/installer distribution | Not implemented | Repository source can be loaded unpacked for development only; no published, signed download exists. |
| Physical-network certification | Not completed | Automated smoke coverage is not proof of Wi-Fi, firewall, VPN, or guest-network behavior. |

## Current architecture

```text
Desktop PWA MeshEngine
  -> extension content bridge
  -> persistent Chrome Native Messaging connection
  -> temporary companion TLS listener on one selected IPv4 address
  -> Android LanCompanionDirect / Android MeshEngine

Fallback: WebRTC direct -> encrypted relay -> persistent outbox / carry-forward
```

The native companion handles routing metadata and encrypted envelope bytes only.
It does not receive workspace plaintext, workspace keys, or arbitrary browser
commands. The receiver remains responsible for signature verification, ratchet
advancement, decryption, duplicate suppression, acknowledgements, and storage.

## Bridge and listener boundaries

The approved browser origin can use only these typed native requests:

```json
{ "type": "screenmesh.listNetworkInterfaces" }
{ "type": "screenmesh.startLanSession", "address": "192.168.1.42", "sessionId": "…", "sessionToken": "…", "expiresAt": 0 }
{ "type": "screenmesh.getLanSession" }
{ "type": "screenmesh.stopLanSession", "sessionId": "…" }
{ "type": "screenmesh.sendLanEnvelope", "recipientDeviceId": "…", "envelopeB64": "…" }
```

The extension is connected only after the user chooses one exact HTTPS
ScreenMesh origin. It uses a persistent Native Messaging port while a local
session is active and stops the listener when that port closes.

Listener safeguards:

- exact selected non-loopback IPv4 bind; no automatic adapter substitution;
- random port, five-minute maximum life, and ten-second handshake deadline;
- TLS 1.2+ ephemeral certificate with selected-IP SAN and SPKI pin;
- one-use token stored only as a hash after session creation;
- four-KiB handshake limit, envelope-size limit, connection cap, and failed
  handshake throttling;
- recipient-device-ID enforcement after Android has authenticated; and
- route-loss state when the selected adapter disappears or the Android socket
  closes.

## Pairing and transport behavior

An inactive listener produces ordinary `SM1` pairing. Activating Local
Companion generates `SM2`, which carries the selected endpoint, random port,
SPKI pin, listener session ID/token, and ordinary pairing data. It never carries
the desktop identity private key, workspace plaintext, or a browser TLS bypass.

Android verifies the certificate pin before it reveals the one-use listener
token. A pin mismatch or unreachable listener leaves normal encrypted relay
pairing available. Once the local socket is authenticated, both MeshEngines try
that route before WebRTC and relay. A failed local send immediately returns
`false`, allowing the established fallback chain to continue without manual
re-send.

The local bootstrap token is intentionally not reusable. If the Android socket,
the selected adapter, extension, or native host disappears, users must generate
a fresh QR to establish a new Local Companion session.

## User-visible state

Pair Device shows:

- available companion routes and warnings for VPN/virtual adapters;
- **Activate Local Companion** after an extension/native host reports routes;
- waiting, connected, adapter-unavailable, and Android-disconnected states;
- firewall/guest-Wi-Fi guidance for an Android connection that does not arrive;
- a Stop control; and
- an explicit unavailable state when the extension/companion is not installed.

Mesh shows the current Local Companion route state. Activity records route
lifecycle metadata such as connection, restoration, and fallback. Security is a
static posture page by design, not a log of sensitive pairing data.

The disabled activation control seen without a companion is expected. It becomes
usable only after the Chromium extension is loaded, its native host is installed
and running, the user connects the extension to the ScreenMesh origin, and route
discovery succeeds.

## Distribution status

There is **no public extension download URL yet**. The extension currently lives
in `apps/companion-extension` and supports unpacked development installation.
The native-host manifest is a template and needs the final published extension
ID plus an installed companion executable.

The PWA intentionally renders a download link only when the production build
sets `VITE_COMPANION_EXTENSION_URL` to the official HTTPS Chrome Web Store or
signed-release page. Until then, it says Local Companion is not available for
download and keeps normal relay pairing available.

## Validation completed

Automated checks recorded for this implementation include:

- workspace TypeScript typechecking;
- JavaScript unit tests (75 at the recorded milestone);
- web production build;
- Android compile/unit tests and TypeScript/Kotlin SM2 compatibility checks;
- route-discovery and Native Messaging smoke tests; and
- LAN smoke coverage: selected-interface bind, advertised TLS pin, one-use
  replay rejection, both envelope directions, wrong-recipient rejection, and
  authenticated-socket-loss fallback.

These checks do not prove that an actual Android phone can reach the desktop on
the selected Wi-Fi, nor that a firewall/VPN/guest network behaves as expected.

## Required next steps, in order

1. **Run physical-device validation.** Follow
   [`LocalCompanionValidation.md`](LocalCompanionValidation.md) using a Windows
   desktop and real Android phone on trusted Wi-Fi. Record bidirectional send /
   receive, Wi-Fi loss, firewall denial, guest isolation, VPN/virtual selection,
   and extension/native-host restart results.
2. **Close resilience coverage gaps.** Add deterministic tests for repeated
   reconnect cycles, extension/service-worker restart, local-plus-fallback
   duplicate delivery, and measured route-fallback timing.
3. **Package the companion.** Build a signed desktop installer that installs
   the native executable, registers the native-host manifest for exactly the
   final extension ID, supports upgrade/uninstall, and cleans up listener or
   firewall state.
4. **Publish the extension.** Package and publish the Chromium extension,
   obtain its stable ID, set `VITE_COMPANION_EXTENSION_URL`, and test the fresh
   install path instead of unpacked developer setup.
5. **Deploy as one compatible release train.** Deploy the signed-pairing server
   update, PWA, Android client, extension, and companion together. Older clients
   send unsigned rotation requests, so a coordinated rollout is required.
6. **Continue broader Phase 6 hardening.** Exercise PWA/browser, Android
   lifecycle, nearby radios, restrictive NAT/firewall networks, and decide on
   TURN after measuring actual WebRTC fallback behavior.

## Bottom line

The earlier mandatory design work is implemented: this is no longer merely a
route selector. The immediate blocker is operational, not protocol design:
perform real-device validation and deliver a signed install/publish flow before
presenting Local Companion as an end-user feature.
