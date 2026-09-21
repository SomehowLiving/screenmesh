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
  connected to one exact HTTPS ScreenMesh origin by the user. It asks only for
  that route list and cannot invoke the agent's command/task functionality.
- The Pair dialog always shows the Local Companion section. When connected, a
  user can select a preferred route and refresh discovery; VPN and virtual
  routes are clearly warned about. The preference does not affect a QR yet.
  Without the companion, the existing encrypted relay workflow is unchanged.

The native-host protocol accepts exactly one request:

```json
{ "type": "screenmesh.listNetworkInterfaces" }
```

No MAC addresses, IPv6 addresses, workspace data, pairing codes, files, or
arbitrary commands cross this bridge.

Route discovery does not inspect the default route, test inbound firewall
access, probe another device, or prove a route is reachable. It only reports
addresses that the local operating system says are assigned to an interface.

## Secure local listener (implemented foundation)

The user can explicitly activate a temporary local listener from the Pair
dialog after selecting an interface. The extension keeps a persistent Native
Messaging connection while it is active. The native companion:

- binds a random TCP port to **only** the selected non-loopback IPv4 address;
  it never binds `0.0.0.0`;
- creates a fresh TLS 1.3 certificate whose IP SAN matches that address and
  returns its SHA-256 SPKI pin;
- accepts only a newline-delimited `screenmesh.lan.hello` carrying a 128-bit
  one-use session token; it retains only a SHA-256 hash of that token;
- has a five-minute maximum lifetime, a ten-second handshake deadline,
  four-KiB handshake limit, and per-source failed-attempt throttling;
- requires an explicit browser confirmation before a VPN or virtual route is
  enabled; it never falls through to another adapter.

The local listener currently establishes the authenticated, pinned-TLS
bootstrap only. It does not accept application data, decrypt payloads, or
replace the relay/WebRTC transport.

## Deliberately not implemented yet: LAN-hosted pairing

Listing an address is not enough to make it safe or usable as a QR target. For
example, advertising `192.168.1.42` requires a secure local ScreenMesh service
that a phone can actually reach. A hosted HTTPS PWA cannot safely switch its
API/WebSocket traffic to an unauthenticated `http://192.168.x.x` endpoint: that
would encounter browser mixed-content and Private Network Access protections.

The next phase is an `SM2` invitation format and Android-native pinned-TLS
client. It will carry the selected endpoint, port, SPKI pin, and one-use session
token alongside the ordinary relay pairing material. Only then can the Pair
dialog put a local route in a QR. Until then, it continues to generate
relay-backed, end-to-end encrypted pairing codes.
