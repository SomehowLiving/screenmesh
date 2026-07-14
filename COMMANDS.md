# Commands

Quick reference for running ScreenMesh locally. Run everything from the repo root unless noted.

## Setup

```bash
pnpm install
```

## Run the backend (relay server)

```bash
pnpm dev:server
```

Starts the Fastify relay on **http://localhost:8787** (watch mode via `tsx watch` — restarts on file changes). Health check: `http://localhost:8787/api/health`.

## Run the frontend (PWA)

```bash
pnpm dev:web
```

Starts the Vite dev server on **https://localhost:5173** (self-signed HTTPS — required for Web Crypto; accept the browser warning once). Listens on all interfaces (`host: true`) so phones on the same Wi-Fi can reach it, and proxies `/api` to the relay server same-origin.

**Run both**: open two terminals, one per command above. `dev:server` must be running before `dev:web` can pair/sync (the frontend calls its `/api` routes).

## Pairing a second device (e.g. your phone)

1. Both commands above running.
2. On the laptop, open `https://localhost:5173`, create a workspace.
3. The QR / join link auto-detects your machine's LAN IP (via `/api/info`) so other devices can reach it.
4. Scan with the phone (same Wi-Fi network). Accept the certificate warning (self-signed dev cert).

If the phone can't connect: check Windows Firewall is allowing Node on ports `5173` and `8787` (private network).

## Two "devices" in one browser (no phone needed)

```
https://localhost:5173/?device=2
```

The `device` query param gives that tab its own local identity/database, separate from the default tab.

## Type-check everything

```bash
pnpm typecheck
```

## Build everything

```bash
pnpm build
```

## Run the smoke tests

Requires `dev:server` running first (uses `127.0.0.1:8787`).

```bash
pnpm smoke
```

Runs both `packages/sync/scripts/smoke.ts` (relay auth + envelope delivery + offline queueing) and `engine-smoke.ts` (full MeshEngine: objects, files, checklists, Yjs merge, continue-on-device, revocation, key rotation).

## Per-package scripts

Run from repo root with `pnpm --filter <package> <script>`, e.g.:

```bash
pnpm --filter @screenmesh/web build      # production build (dist/)
pnpm --filter @screenmesh/web preview    # preview the production build
pnpm --filter @screenmesh/server start   # run server without watch mode
```
