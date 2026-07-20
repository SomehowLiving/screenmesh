/**
 * Dev helper: creates a throwaway workspace against a running relay
 * server and prints the "SM1.…" pairing code (the same string a QR code
 * or NFC tag carries) to stdout — useful for manually pasting into a
 * client (e.g. the Android app on an emulator/device) without going
 * through the web app's pairing UI.
 *
 * Run: pnpm exec tsx packages/sync/scripts/mint-pairing-code.ts [name]
 */
import {
  encodePairingPayload,
  exportEncryptionPublicKey,
  exportPublicKey,
  exportRawWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
} from "@screenmesh/crypto";
import { toBase64, type CreateWorkspaceRequest } from "@screenmesh/protocol";

const SERVER = "http://127.0.0.1:8787/api";

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "ui-test";
  const a = await generateIdentity();
  const workspaceKey = await generateWorkspaceKey();
  const workspaceId = crypto.randomUUID();
  const pairingToken = crypto.randomUUID();
  const expiresAt = Date.now() + 10 * 60_000;

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name, createdAt: Date.now() },
    device: {
      id: a.deviceId,
      name: "TS Device A",
      publicKey: await exportPublicKey(a.publicKey),
      encryptionKey: await exportEncryptionPublicKey(a.encryptionPublicKey),
      type: "laptop",
    },
    pairingToken,
    tokenExpiresAt: expiresAt,
  } satisfies CreateWorkspaceRequest);

  const code = encodePairingPayload({
    workspaceId,
    workspaceKey: toBase64(await exportRawWorkspaceKey(workspaceKey)),
    pairingToken,
    expiresAt,
  });

  console.error(`workspace ${workspaceId} created (owner ${a.deviceId})`);
  console.log(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
