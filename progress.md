# ScreenMesh Progress

## Current status

ScreenMesh's core device-mesh workflow is implemented: encrypted pairing,
relay/WebRTC delivery, offline recovery, per-pair ratcheting, Android support,
and the trusted desktop agent are in place. The newest Local Companion work has
also reached its first end-to-end transport milestone:

```text
PWA MeshEngine
  -> Chrome extension / native companion bridge
  -> pinned-TLS listener on the selected desktop IPv4 address
  -> Android MeshEngine

Fallback: WebRTC -> encrypted relay -> persistent outbox
```

The local path carries only already-encrypted `SecureEnvelope` bytes. It does
not replace ScreenMesh encryption, decrypt workspace content, or weaken the
existing acknowledgement, duplicate suppression, ratchet, and outbox rules.

## Recent updates

### Secure Local Companion foundation: complete

- Added desktop network-route discovery through the optional native companion.
  It returns non-loopback IPv4 routes only and recommends private Wi-Fi or
  Ethernet addresses as a heuristic.
- Added explicit route selection in the web Pair Device UI, including clear
  warnings and a required confirmation for VPN or virtual interfaces.
- Added a temporary listener that binds to one user-selected IPv4 address on a
  random port. It never binds to all interfaces (`0.0.0.0`).
- Added a fresh TLS certificate per listener with an IP SAN and a QR-provided
  SHA-256 SPKI pin.
- Added a one-use, 128-bit session token. The native host retains only its
  hash and expires the listener after at most five minutes.
- Hardened the listener with a ten-second handshake deadline, handshake-size
  limit, connection cap, and failed-attempt throttling.
- Switched the extension to persistent Native Messaging while a local session
  is active, and ensured the listener stops when that connection closes.

### SM2 local-pairing bootstrap: complete

- Added the versioned `SM2` QR invitation format alongside existing `SM1`
  pairing, preserving compatibility for ordinary relay-backed pairing.
- An active SM2 QR includes the selected endpoint, random port, TLS SPKI pin,
  listener session ID/token, and normal short-lived pairing material. It does
  not include a relay URL, desktop private key, or plaintext workspace data.
- Android parses SM2, checks the TLS public-key pin before revealing its
  one-use token, and falls back safely to normal encrypted relay pairing when
  the local route cannot be used.
- Mobile-browser PWA joins intentionally remain relay-backed: a public HTTPS
  page cannot safely or reliably open a self-signed private-LAN socket.

### LanCompanionDirect transport: complete

- Android now keeps the authenticated SM2 TLS socket open after bootstrap.
- The companion ties that socket to the authenticated Android device ID and
  rejects a desktop envelope addressed to any other device.
- The PWA and Android engines attempt this direct LAN route before existing
  WebRTC and encrypted-relay delivery.
- Direct-route failures return control immediately to the established fallback
  chain, while queued work remains protected by the persistent outbox.

## Security properties retained

- Workspace payloads remain end-to-end encrypted and signed.
- The companion handles opaque encrypted bytes and limited routing metadata;
  it is not a trusted plaintext processor or message store.
- Local bootstrap uses a pinned certificate and a short-lived, one-use secret.
- The listener is scoped to the selected interface and cannot silently switch
  to another route.
- Existing replay protection, recipient validation, acknowledgements, and
  duplicate delivery handling remain the system of record.

## Recorded automated validation

The Local Companion milestones were last validated with:

- workspace TypeScript typechecking;
- 75 JavaScript tests;
- production web build;
- Android compile and unit tests;
- TypeScript/Kotlin SM2 wire-format compatibility tests;
- route-discovery and companion smoke tests; and
- bidirectional LAN smoke coverage for TLS-pin validation, one-use token
  replay rejection, Android-to-desktop and desktop-to-Android framing, and
  wrong-recipient rejection.

These are automated checks, not a production or real-network certification.

## Remaining work, in order

1. **Resilience and route visibility**
   - Add active-route status, route-health events, reconnect/backoff rules,
     and clear explanations for local-route, extension, firewall, and VPN
     failures.
   - Define deterministic failover and recovery behavior across Local
     Companion, WebRTC, relay, and the outbox.
   - Add tests for listener/extension restarts, socket loss during send,
     repeated reconnects, and direct-plus-fallback duplicate delivery.
   - Exit criterion: users can see which route is active and delivery recovers
     without manual re-send when the local route disappears.

2. **Real-device and hostile-network validation**
   - Test an actual Android phone and desktop over Wi-Fi and Ethernet.
   - Exercise VPN/virtual adapters, guest-Wi-Fi isolation, firewall denial,
     incorrect route selection, expired and replayed SM2 QR codes, and
     extension/service-worker restarts.
   - Record pairing time, route chosen, delivery time, fallback behavior, and
     whether the UI made the outcome understandable.
   - Exit criterion: documented evidence that both directions send and receive
     over selected LAN routes and safely fall back on failure.

3. **Release packaging and deployment**
   - Package and sign the desktop companion and Chromium extension.
   - Register the native-host manifest with the final extension ID and add
     clean install, upgrade, uninstall, and listener/firewall cleanup paths.
   - Deploy the signed-pairing server update, then publish the compatible PWA
     and Android build together. Older clients send unsigned rotation requests,
     so coordinated rollout is required.
   - Exit criterion: a fresh-user installation can pair, activate Local
     Companion, update safely, and remove cleanly.

4. **Broader production hardening**
   - Complete the existing Phase 6 real-device checks for PWA, Android
     lifecycle, cross-browser/iOS behavior, nearby radios, and restrictive
     networks.
   - Decide whether TURN infrastructure is needed after measuring WebRTC
     behavior on restrictive NAT/firewall networks.

## Current release caveats

- No deployment has been performed from this workspace: the Railway CLI was
  not linked to a Railway project, so there was no safe deployment target.
- Local Companion is currently supported for the Android native client. The
  browser PWA remains on WebRTC/relay for transport.
- Route discovery is advisory, not a reachability or firewall test.
- Packaged/signed installer and real Android-phone-on-Wi-Fi validation are
  still required before treating Local Companion as production-ready.

## Key references

- `docs/LocalCompanion.md`: Local Companion design, implemented protocol, and
  remaining phases.
- `docs/Roadmap.md`: product roadmap and wider real-world hardening plan.
- `docs/Security.md`: cryptographic and trust-boundary design.
