# Local Companion

The hosted ScreenMesh PWA runs within a browser sandbox and cannot enumerate a
computer's adapter names or IP addresses. The optional Local Companion provides
that narrowly scoped capability without weakening the normal hosted-relay flow.

## Implemented foundation

- `apps/agent --companion-native-host` exposes only local non-loopback IPv4
  route names, addresses, and broad types (`wifi`, `ethernet`, `vpn`,
  `virtual`, or `other`) via Chrome Native Messaging. It marks one route as
  a **recommendation** by preferring private-address Wi-Fi/Ethernet routes;
  this is a heuristic, not a reachability test.
- `apps/companion-extension` is a Chromium extension that must be explicitly
  connected to one exact HTTPS ScreenMesh origin by the user. It can request a
  route list and use typed start/status/stop controls for the temporary local
  listener; it cannot invoke the agent's command/task functionality.
- The Pair dialog always shows the Local Companion section. When connected, a
  user can select a preferred route and refresh discovery; VPN and virtual
  routes are clearly warned about. The preference does not affect a QR yet.
  Without the companion, the existing encrypted relay workflow is unchanged.

The native-host protocol accepts only these typed requests:

```json
{ "type": "screenmesh.listNetworkInterfaces" }
{ "type": "screenmesh.startLanSession", "address": "192.168.1.42", "sessionId": "…", "sessionToken": "…", "expiresAt": 0 }
{ "type": "screenmesh.getLanSession" }
{ "type": "screenmesh.stopLanSession", "sessionId": "…" }
```

No MAC addresses, IPv6 addresses, workspace keys, relay pairing tokens, files,
or arbitrary commands cross this bridge. The local listener session token is a
separate short-lived one-use secret and is necessary for the pinned-TLS
bootstrap.

Route discovery does not inspect the default route, test inbound firewall
access, probe another device, or prove a route is reachable. It only reports
addresses that the local operating system says are assigned to an interface.

## Secure local listener (implemented foundation)

The user can explicitly activate a temporary local listener from the Pair
dialog after selecting an interface. The extension keeps a persistent Native
Messaging connection while it is active. The native companion:

- binds a random TCP port to **only** the selected non-loopback IPv4 address;
  it never binds `0.0.0.0`;
- creates a fresh TLS 1.2+ certificate whose IP SAN matches that address and
  returns its SHA-256 SPKI pin;
- accepts only a newline-delimited `screenmesh.lan.hello` carrying a 128-bit
  one-use session token; it retains only a SHA-256 hash of that token;
- has a five-minute maximum lifetime, a ten-second handshake deadline,
  four-KiB handshake limit, and per-source failed-attempt throttling;
- requires an explicit browser confirmation before a VPN or virtual route is
  enabled; it never falls through to another adapter.

## LAN companion direct transport (implemented)

After Android has verified the SM2 certificate pin and consumed its one-use
session token, it keeps that TLS connection open as `LanCompanionDirect`.
The desktop PWA engine and Android engine then use it before WebRTC and the
encrypted relay:

```text
PWA MeshEngine -- encrypted SecureEnvelope bytes --> extension/native host
  --> selected-interface companion TLS socket --> Android MeshEngine

Android MeshEngine -- encrypted SecureEnvelope bytes --> same TLS socket
  --> companion native event --> extension --> PWA MeshEngine
```

The companion sees framing metadata and opaque serialized envelope bytes only;
it does not decrypt workspace content, retain messages, or invent a second
application protocol. The listener associates the socket with the Android
device ID sent in its authenticated hello and refuses a desktop envelope whose
recipient ID does not match that identity. Existing envelope signatures,
ratchet encryption, message-ID duplicate suppression, acknowledgements, and
outbox behavior remain the authority for correctness.

If the TLS socket, extension, or native host fails, direct delivery returns
false and `MeshEngine` immediately uses its existing WebRTC then encrypted
relay fallback. A queued outbox item is retried when a route opens.

## SM2 local-pairing invitation (implemented)

Once the listener is active, the QR becomes an `SM2` invitation. In addition
to the existing short-lived, relay-authorized pairing material, it carries the
selected IPv4 address, random port, ephemeral certificate SPKI pin, listener
session ID, and one-use listener token. It does **not** carry a relay URL,
desktop identity private key, or application plaintext.

Android validates the TLS public-key pin before it sends the listener token.
If the route is unavailable or the handshake fails, Android reports that it
joined through the encrypted relay fallback; it does not send the token on a
pin mismatch. A mobile-browser PWA parses SM2 but continues directly to the
normal relay join because public HTTPS pages cannot reliably connect to a
self-signed private LAN endpoint.

## Browser boundary

The hosted PWA never opens a browser network socket to `192.168.x.x`; that
would be subject to mixed-content, certificate, CORS, and Private Network
Access restrictions. Its narrow extension/native bridge sends opaque envelope
bytes to the local companion instead. Mobile-browser PWA joins continue to use
WebRTC/relay; the supported LAN client in this phase is Android native.

## Remaining implementation phases

1. **Negotiation and resilience:** route health now detects selected-adapter
   loss locally, reports Android/native-host disconnects, shows active/waiting/
   fallback state in Pair Device, and records local-route lifecycle events in
   Activity. A broken or unavailable local path immediately returns to
   WebRTC/relay; a consumed bootstrap token requires a fresh QR to reconnect.
   Remaining work: real Wi-Fi evidence, broader repeated-reconnect and
   duplicate-delivery coverage, and measured fallback timing.
2. **Release packaging:** package and sign the companion, register a native
   host manifest with the published extension ID, and add installer/removal
   cleanup for the listener/firewall state.
3. **Real-device validation:** test Android-to-desktop on Wi-Fi, Ethernet,
   VPN, guest Wi-Fi isolation, firewall denial, expired/replayed QR, and
   extension/service-worker restarts. Keep the mobile PWA on WebRTC/relay
   unless a managed trusted-LAN HTTPS model is introduced.

See `docs/LocalCompanionValidation.md` for the executable Wi-Fi validation
runbook, expected firewall/VPN/guest-network behavior, and release evidence.

## Download link configuration

The Pair Device UI displays a **Get Local Companion extension** link only when
the production PWA is built with `VITE_COMPANION_EXTENSION_URL` set to the
official HTTPS Chrome Web Store listing or signed-release page. Do not point it
at a development unpacked-extension folder or an unsigned third-party mirror.
Until a signed extension and matching native companion installer are published,
the UI correctly states that Local Companion is not yet available for download
and retains normal WebRTC/relay pairing.
