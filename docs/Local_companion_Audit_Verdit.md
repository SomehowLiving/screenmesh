## Audit verdict

**A. Route discovery only.**

The current Local Companion can return and display local IPv4 interface names/addresses. It does not select a companion route, host a LAN service, mint a LAN-aware QR, accept a phone connection, or transport any data.

## 1. Current implementation

Implemented files:

| Area | Files | Current responsibility |
|---|---|---|
| Native companion | [companion.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\src\companion.ts), [index.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\src\index.ts) | Enumerates local IPv4 interfaces and exposes one Native Messaging request. |
| Browser extension | [manifest.json](C:\Users\nidhi\dev\ScreenMesh\apps\companion-extension\manifest.json), [background.js](C:\Users\nidhi\dev\ScreenMesh\apps\companion-extension\background.js), [bridge.js](C:\Users\nidhi\dev\ScreenMesh\apps\companion-extension\bridge.js), [popup.js](C:\Users\nidhi\dev\ScreenMesh\apps\companion-extension\popup.js) | Lets a user approve one ScreenMesh web origin, then bridges route-list requests to the native host. |
| PWA integration | [companion.ts](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\lib\companion.ts), [Pair.tsx](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\components\Pair.tsx) | Requests routes once and displays them as “Local companion connected.” |
| Documentation/test | [LocalCompanion.md](C:\Users\nidhi\dev\ScreenMesh\docs\LocalCompanion.md), [companion-smoke.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\scripts\companion-smoke.ts) | Documents the limitation and tests enumeration plus Native Messaging framing. |

Communication path today:

```text
PWA
  CustomEvent: screenmesh-companion-request
    ↓
Extension content script
  chrome.runtime.sendMessage()
    ↓
Extension service worker
  chrome.runtime.sendNativeMessage()
    ↓
Native Messaging stdio process
  screenmesh.listNetworkInterfaces
    ↓
Agent os.networkInterfaces()
```

The native protocol accepts exactly this request:

```json
{ "type": "screenmesh.listNetworkInterfaces" }
```

It returns route metadata only:

```json
{
  "ok": true,
  "interfaces": [
    { "name": "Wi-Fi", "address": "192.168.1.42", "kind": "wifi" }
  ]
}
```

What it can do today:

- Return non-loopback IPv4 interface names and addresses.
- Categorize routes heuristically.
- Display those routes in the Pair dialog.
- Keep normal relay pairing unchanged if the extension/agent is absent.

What it cannot do:

- Start a TCP, HTTP, HTTPS, WebSocket, WebRTC, or QUIC listener.
- Bind to any selected interface.
- Test reachability.
- Select a companion route in the UI.
- Include a companion route in a QR.
- Let Android or a mobile PWA connect locally.
- Forward encrypted envelopes.
- Package/install the agent or register the Native Messaging host automatically.

The extension is currently development scaffolding. Its native-host manifest is only a template and needs a real installed executable plus a fixed published extension ID.

## 2. Local network routes

The companion calls Node’s `os.networkInterfaces()` in [companion.ts](C:\Users\nidhi\dev\ScreenMesh\apps\agent\src\companion.ts).

Rules implemented:

- Only `IPv4` entries are returned.
- Loopback/internal interfaces are omitted.
- No IPv6, MAC address, gateway, subnet mask, DNS server, or routing-table information is returned.
- Classification is based entirely on adapter-name regexes.

| Category | Matching examples |
|---|---|
| Wi‑Fi | `Wi-Fi`, `Wireless`, `WLAN`, `Airport` |
| Ethernet | `Ethernet`, `eth`, `en0`-style names |
| VPN | `WireGuard`, `OpenVPN`, `Tailscale`, `TAP`, `tun`, `utun`, etc. |
| Virtual | `Docker`, `WSL`, `Hyper-V`, `vEthernet`, VMware, VirtualBox |
| Other | Anything not matched |

VPN and virtual routes are distinguished in the returned `kind` field, and sorted after Wi‑Fi/Ethernet. This is classification only—not validation. A strangely named VPN could be `other`; a corporate adapter could be misclassified.

There is currently no reachability determination. The code does not:

- Inspect the default route.
- Check link state.
- Check whether a firewall would allow inbound traffic.
- Bind a socket to test the address.
- Probe a phone or peer.
- Verify that another device is on the same subnet.

The companion routes are only displayed. The existing “Network interface / Use this network” selector is separate: it uses `listLanCandidates()` from [app.ts](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\lib\app.ts:90), which asks the current server’s `/info` endpoint. It does not use `companionRoutes`.

## 3. Pairing

### Does the current QR contain a LAN endpoint?

**No in production.**

The QR wire format is:

```text
SM1.<workspaceId>.<pairingToken>.<workspaceKey>.<expiresAt>
```

It intentionally does not serialize `serverUrl`; this is explicitly tested in [pairing.test.ts](C:\Users\nidhi\dev\ScreenMesh\packages\crypto\src\pairing.test.ts:33).

In production, [makeJoinUrl](C:\Users\nidhi\dev\ScreenMesh\apps\web\src\lib\app.ts:396) points the QR link to the deployed PWA origin. The receiving PWA then uses its configured relay origin. A companion-discovered `192.168.1.42` never enters this flow.

In local development only, the outer join URL can point at a LAN-hosted Vite server. That is why the old local behavior appeared functional.

### If Wi‑Fi `192.168.1.42` is selected, can a device connect?

**Not through the Local Companion.** Companion routes are not selectable and have no listening service behind them.

The missing component is a local, authenticated LAN listener plus a new invitation format that carries:

- Selected endpoint address and port.
- A short-lived listener-session identifier.
- A TLS/public-key pin for the listener.
- The normal ScreenMesh pairing token and pairing secret.

### Existing pairing token behavior

- Generated by `createPairingPayload()` using 16 random bytes.
- Default TTL: five minutes.
- Registered on the relay by `rotatePairing()`.
- Redeemed at `POST /workspaces/:id/join`.
- The relay marks it `used: true` on the first successful join.
- Later redemption fails with `403`.

So the same QR cannot be successfully reused after redemption or expiry. However, it is a bearer credential: anyone who obtains it before the intended device redeems it can race to join first.

Important audit finding: the current `POST /pairing-token` endpoint checks whether the submitted `deviceId` equals the workspace owner ID, but does not cryptographically authenticate that HTTP request. That must be fixed before using it to mint LAN invitations. Relay WebSocket authentication is stronger: it uses an Ed25519 challenge signature.

## 4. Local Companion server

**There is no Local Companion server today.**

The companion does not listen on any port or bind any address. `--companion-native-host` only reads/writes Chrome Native Messaging frames over stdin/stdout.

Existing but unrelated listeners:

- The hosted Fastify relay listens on port `8787`.
- Android Wi‑Fi Direct has a raw TCP socket on `8988`; it is Android-to-Android Wi‑Fi Direct code, not the desktop companion and not connected to the web PWA’s engine.

The future service needs to:

1. Bind only to the selected local IPv4 address, never `0.0.0.0` by default.
2. Use a random high port per enabled local session.
3. Require TLS and pin its ephemeral public key from the QR.
4. Require a short-lived, single-use invite before accepting a transport session.
5. Forward only already-encrypted ScreenMesh envelope bytes.
6. Stop and close the firewall rule when the pairing session ends.

## 5. Phone connection paths

### A. Desktop Companion → Android/native ScreenMesh

This is the recommended first target.

Proposed flow:

```text
Desktop PWA encrypts ScreenMesh envelope
  ↓ extension + Native Messaging
Desktop Companion LAN transport
  ↓ pinned TLS WebSocket or QUIC on chosen Wi‑Fi address
Android native ScreenMesh
  ↓
Android MeshEngine verifies, ratchets, decrypts
```

- Discovery: explicit QR scan; mDNS can be an optional later convenience, not a trust mechanism.
- QR bootstrap: introduce a versioned `SM2` invitation containing endpoint, port, listener public-key fingerprint, listener-session token, existing pairing token, pairing secret, and expiry.
- Authentication: Android validates the TLS key pin from the QR, presents the one-time token, registers its device identity with the relay, then authenticates future messages through existing signatures and ratchet state.
- Data: `SecureEnvelope` bytes remain end-to-end encrypted; TLS protects the LAN hop and prevents trivial local-network tampering.

Android already has relay pairing and separate BLE/NFC/Wi‑Fi Direct experiments, but it does not currently implement this desktop-companion LAN client.

### B. Desktop Companion → mobile-browser PWA

This is not a reliable first implementation.

The mobile PWA could scan a QR containing a LAN endpoint, but then a public HTTPS page would need to open `https://192.168.1.42:port` or `wss://192.168.1.42:port`.

Problems:

- `http://192.168.x.x` and `ws://192.168.x.x` from an HTTPS PWA are blocked mixed content.
- `https://192.168.x.x` requires a certificate trusted by the phone and valid for that IP/name.
- A self-signed certificate cannot be silently accepted by browser JavaScript.
- Cross-origin requests require CORS.
- Private Network Access may require an explicit private-network preflight/opt-in.
- Mobile Chrome generally cannot run this desktop browser extension.

Chrome documents that public-to-private network requests are restricted by Private Network Access, and that HTTPS pages cannot simply fetch private HTTP addresses; both endpoints need secure handling. [Chrome PNA guidance](https://developer.chrome.com/blog/private-network-access-update) and [MDN mixed-content guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content).

For mobile browsers, the practical route is existing WebRTC direct transfer with relay signaling. It can use a LAN path when ICE succeeds, then fall back to the encrypted relay. The local companion does not need to be in that path initially.

## 6. Browser-security answer

For a hosted HTTPS PWA:

| Question | Answer |
|---|---|
| Can it directly use `http://192.168.x.x`? | No; active mixed content such as `fetch()` and WebSockets is blocked. |
| Can it use `https://192.168.x.x`? | Only if the phone trusts a certificate valid for that IP/name. A self-signed companion certificate is not enough. |
| Does PNA matter? | Yes. Public web origins accessing private endpoints are the exact threat PNA addresses. Its rollout details have changed, so the implementation must not rely on current lax behavior. |
| Is CORS required? | Yes, for cross-origin browser requests. CORS is not authentication. |
| Does the companion need HTTPS/WSS? | Yes for a browser-facing LAN endpoint. |
| Is this reliable cross-browser? | No, not without managed DNS/certificates or a native app. Safari and Chrome differ materially here. |

The extension bridge avoids PNA, CORS, and mixed content only for **desktop PWA → local agent metadata access**, because it uses Chrome’s privileged extension/native-messaging path rather than a network request. Chrome Native Messaging restricts native host access to explicit extension IDs. [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

## 7. Transport negotiation

The documented transport order is:

```text
LAN direct → WebRTC direct → encrypted relay → native nearby → QR/file → queue/carry
```

Actual web implementation today is narrower:

```text
WebRTC direct, if open
  ↓ otherwise
WebSocket encrypted relay
  ↓ otherwise
Encrypted outbox / later carry-forward
```

The generic `TransportNegotiator` exists, but the web `MeshEngine` does not currently use it. It uses an optional direct channel followed by the relay. `lan` exists only as a transport-kind type, not an implementation.

The Local Companion should not itself be treated as the transport. It should enable a new **`LanCompanionDirect` transport**:

```text
PWA MeshEngine
  ↓ encrypted envelope
Composite direct channel:
  1. LanCompanionDirect, if session is verified and open
  2. WebRtcDirect
  ↓
WebSocket relay
  ↓
Outbox / encrypted carrier delivery
```

The companion provides privileged local capabilities; `LanCompanionDirect` is the actual transport adapter.

## 8. Security threat model

### Current implementation

- Another Wi‑Fi device: cannot connect; there is no listener.
- Another website: cannot call the extension bridge because the content script is registered only after the user approves one origin, and the background worker checks that exact `sender.origin`.
- A script/XSS running inside the approved ScreenMesh origin: can request the route list. It cannot currently execute arbitrary native commands.
- Another extension: cannot call the native host if the installed native-host manifest permits only the ScreenMesh extension ID. The current repository has only a template, so this is not yet enforceable in a release install.
- QR replay: current relay token is one-use server-side, but whoever redeems it first wins.
- Brute force: 128-bit token entropy is sufficient; rate limiting and bounded handshake parsing are still needed.
- VPN exposure: no listener exists, so none today.
- Wrong interface: only a displayed route; no effect today.

### Required protections for a future listener

- Default to Wi‑Fi/Ethernet; do not auto-enable VPN or virtual interfaces.
- Require explicit advanced confirmation before binding to VPN.
- Bind only to the selected address.
- Use ephemeral TLS identity and QR SPKI pinning.
- Use a separate, short-lived session token, stored as a hash.
- Atomically consume the pairing token at the authoritative relay.
- Authenticate owner token rotation with a signed request; do not trust a submitted owner device ID.
- Rate-limit failed handshakes and close idle connections.
- Expose generic failures only; do not reveal workspace/device existence.
- Add a user-visible “LAN pairing active on Wi‑Fi / 192.168.1.42” indicator and Stop button.
- Fall back to WebRTC/relay if local connection fails; never silently try another interface.

## 9. Recommended architecture

```text
Hosted PWA
  - owns identity, workspace key, ratchet, plaintext handling
  - encrypts/decrypts SecureEnvelope payloads
        │
        │ CustomEvent bridge; exact approved web origin only
        ▼
Chromium extension
  - validates trusted origin
  - exposes narrow typed commands
  - uses persistent Native Messaging only for LAN transport mode
        │
        │ Chrome Native Messaging: length-prefixed JSON over stdio
        ▼
Local Companion
  - enumerates interfaces
  - binds selected interface only
  - owns ephemeral TLS listener and LAN session lifecycle
  - forwards opaque encrypted envelopes only
        │
        │ WSS/QUIC over selected LAN interface, TLS key pinned by QR
        ▼
Android ScreenMesh
  - validates QR pin + one-time token
  - joins/authenticates with relay
  - verifies signatures, advances ratchet, decrypts envelopes
```

The companion must not receive arbitrary shell commands through this bridge, and should not receive workspace plaintext. The PWA should pass it ciphertext envelopes only.

## 10. Implementation plan

| Phase | Work | Files/API | Security/testing |
|---|---|---|---|
| 0. Harden current foundation | Package agent, publish extension, install native-host manifest, add stable extension ID. | Agent installer; extension manifest; native-host installer integration. | Code signing, OS-scoped host registration, exact extension ID; Chrome integration test. |
| 1. Fix invitation authority | Replace owner-ID-only pairing-token rotation with signed owner authorization. | `apps/server`, protocol request type, web/Android pairing clients. | Replay-resistant signed request and server nonce; authorization and replay tests. |
| 2. Secure LAN listener | Add explicit companion `startLanSession` / `stopLanSession`; bind selected IPv4 only; ephemeral TLS key/cert. | New `apps/agent/src/lan/*`; extension bridge protocol. | Bind/firewall tests, wrong-interface test, TLS pin tests, no `0.0.0.0` default. |
| 3. Versioned QR invitation | Add `SM2` format carrying endpoint, port, TLS pin, listener session ID, normal pairing material, expiry. | `packages/protocol`, `packages/crypto`, PWA Pair UI, Android parser. | Fuzz parser, expiry, one-use race, QR-size/scannability tests. |
| 4. Android LAN client | Android pinned-TLS LAN transport; use QR to connect and then deliver opaque envelopes. | New Android LAN transport, pairing UI, tests. | Certificate-pin mismatch tests, token replay tests, real Wi‑Fi hardware tests. |
| 5. Engine integration | Add `LanCompanionDirect`; compose it before WebRTC and relay. | `packages/transport`, `packages/sync`, PWA extension bridge. | Route-order, failover, duplicate-delivery, offline-queue tests. |
| 6. Browser path decision | Keep mobile PWA on WebRTC/relay unless a trusted LAN HTTPS deployment model is chosen. | Potentially no companion listener API for PWA. | Chrome/Safari PNA/mixed-content matrix; do not promise unsupported behavior. |
| 7. UX/fallback | Explicit route choice, VPN warning, active-session display, stop control, relay fallback. | `Pair.tsx`, settings/device UI. | End-to-end failure tests: bad route, VPN-only, firewall, expired QR, companion stopped. |

## Bottom line

The implementation is **route discovery only**. It is a safe beginning for desktop-side local interface visibility, but it is not yet local pairing or local transport. The next mandatory engineering step is not “add a selector”; it is fixing signed invitation authority and designing the secure Android-native LAN listener/session protocol.