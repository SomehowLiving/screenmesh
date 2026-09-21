# ScreenMesh Local Companion extension

This Chromium extension is the deliberately narrow bridge between a user-approved
ScreenMesh web origin and the locally installed ScreenMesh Companion. It exposes
only adapter names, IPv4 addresses, broad adapter kinds, and typed controls for
a temporary selected-interface LAN listener; it cannot execute commands or read
workspace plaintext.

## Distribution status

This directory is a **development extension**, not a public download. Load it
unpacked only for local development. A user-facing Local Companion release needs:

1. a packaged, signed Chromium extension with a stable published extension ID;
2. a signed desktop companion installer that registers a native-host manifest
   permitting exactly that extension ID; and
3. a production PWA build with `VITE_COMPANION_EXTENSION_URL` set to the
   official HTTPS Chrome Web Store or signed-release page.

Until then, ScreenMesh leaves Local Companion unavailable to ordinary users and
continues with WebRTC/relay pairing and delivery.

## Development setup

1. Load this directory as an unpacked extension at `chrome://extensions`.
2. Put the unpacked extension ID in a copy of
   `native-host/com.screenmesh.companion.json.template`, then register that native
   host manifest for Chrome. The manifest must launch the agent with
   `--companion-native-host` (or `pnpm --filter @screenmesh/agent companion` in a
   development launcher).
3. Open the intended HTTPS ScreenMesh deployment, click the extension, and select
   **Connect this ScreenMesh site**. The extension requests access to that exact
   site; it injects no bridge into other sites.
4. Reload ScreenMesh. The web app can now query routes and, only after an
   explicit user action, start/stop a short-lived TLS listener bound to one
   selected address. The listener is not a browser-accessible HTTP API.

For release, package the agent as an installed executable and create the native
host manifest as part of its installer. Do not ship a manifest that allows
wildcard extension IDs.
