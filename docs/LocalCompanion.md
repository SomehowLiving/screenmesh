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

## Deliberately not implemented yet: LAN-hosted pairing

Listing an address is not enough to make it safe or usable as a QR target. For
example, advertising `192.168.1.42` requires a secure local ScreenMesh service
that a phone can actually reach. A hosted HTTPS PWA cannot safely switch its
API/WebSocket traffic to an unauthenticated `http://192.168.x.x` endpoint: that
would encounter browser mixed-content and Private Network Access protections.

The next phase is a local service with a phone-trustable HTTPS identity and an
explicit user-controlled LAN bind. Only after that exists should the Pair dialog
offer **Use this local route** for QR generation. Until then, it continues to
generate relay-backed, end-to-end encrypted pairing codes.
