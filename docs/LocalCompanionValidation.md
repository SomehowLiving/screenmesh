# Local Companion Wi-Fi Validation

This runbook validates the supported Local Companion route: a desktop PWA,
the Chromium companion extension/native host, and one physical Android phone on
the same trusted Wi-Fi. It is deliberately a manual validation: automated
smoke tests cannot prove Wi-Fi isolation, Windows firewall policy, or an actual
Android TLS connection.

## Preconditions

- Use a private, non-guest Wi-Fi network. Connect the desktop and Android
  phone to the same SSID; turn off cellular data on the phone for the primary
  pass so fallback cannot be mistaken for local success.
- Run a current PWA build, extension, native companion, and Android APK from
  the same release train. Do not use a legacy client that sends unsigned
  pairing-rotation requests.
- In the extension, explicitly grant access to the exact ScreenMesh HTTPS
  origin. Confirm the native-host manifest uses the installed extension ID.
- On Windows, respond to a ScreenMesh/Node firewall prompt by allowing
  **Private networks only**. Do not open a broad port rule: the listener uses
  a fresh random port and is bound only to the selected address.
- Keep the relay reachable. The test needs it to establish normal workspace
  pairing and to prove safe fallback after local-route failure.

## Primary Wi-Fi test

1. Open the desktop PWA as the workspace owner and go to **Pair Device**.
2. Under **Local companion routes**, refresh routes and select the private
   Wi-Fi address. Do not choose VPN or virtual adapters for this pass.
3. Activate the local listener. The UI should show **Waiting for Android**,
   its selected address and random port, plus the firewall/guest-Wi-Fi hint.
4. Scan the resulting SM2 QR code in the Android app and complete pairing.
5. Confirm the desktop changes to **Local Companion connected** and the
   Activity page records a `Local Companion connected` network event.
6. Send a small text object from desktop to Android, then Android to desktop.
   Each must arrive once, decrypt normally, and show normal delivery state.
7. With both clients still open, send a second object in each direction to
   confirm the kept-open TLS route handles more than the bootstrap exchange.

Record the selected adapter/address, pairing duration, first-delivery duration,
second-delivery duration, Activity entries, and user-visible route state.

## Required failure and recovery tests

| Scenario | Action | Expected result |
| --- | --- | --- |
| Android local socket loss | Turn off phone Wi-Fi or force-close the Android app after pairing. | Desktop reports that the Android local connection ended, removes the local peer, records the fallback event, and continues delivery through WebRTC or encrypted relay. A new QR is required for local reconnection. |
| Desktop Wi-Fi/interface loss | Disconnect/reconnect Wi-Fi or switch adapters while the listener is active. | Route health changes to selected-interface unavailable. The UI instructs the user to refresh routes and generate a new code; no interface is silently substituted. |
| Firewall denial | Deny the Private-network firewall prompt, or use a test policy that blocks the companion executable. | Android cannot establish local TLS and completes ordinary relay pairing where available. The desktop remains in “Waiting for Android”; the UI directs the user to firewall/private-network checks. No insecure bypass is offered. |
| Guest-Wi-Fi/client isolation | Put the phone on guest Wi-Fi or enable AP isolation. | Android safely falls back to relay; no local connection is claimed. |
| VPN/virtual route | Select it only after the explicit warning and verify the phone cannot reach it, then repeat with Wi-Fi. | Failure is understandable and relay continues; the app never silently moves the listener to Wi-Fi. |
| Extension/native restart | Disable/re-enable the extension or stop the native host after connection. | The PWA receives a route-loss event, removes the local peer, and preserves normal fallback delivery. Recreate Local Companion with a new QR after restoration. |

## Pass criteria

- Bidirectional encrypted objects arrive once over the selected Wi-Fi route.
- The desktop identifies local route activation and loss clearly.
- Firewall, isolation, adapter loss, Android disconnect, and extension loss do
  not interrupt eventual delivery or produce a plaintext/insecure fallback.
- A lost local route requires explicit fresh pairing material; it never
  reconnects using an already-consumed bootstrap token.

## Evidence to attach to the release record

- App, extension, companion, and Android build identifiers.
- Network type, selected address class, OS version, and Android model/API.
- Timestamps and screenshots of connected, fallback, and recovery states.
- Activity export or screenshots showing route events (without QR tokens,
  pairing secrets, private keys, or object contents).
- Any firewall prompt/policy outcome and whether relay/WebRTC fallback was
  observed.
