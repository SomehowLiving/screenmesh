/**
 * Interop smoke test: proves the hand-ported Kotlin/Android MeshEngine
 * (apps/android) can actually talk to the real TypeScript engine over a
 * live relay — the one thing compiling/linting the Kotlin code alone
 * could never prove. See docs/Android.md's "Verification status".
 *
 * This is device A (TypeScript). It creates a workspace, writes the join
 * info to a handoff file for the Kotlin side to read, waits for the
 * Kotlin device to join and come online, sends it a text object, and
 * waits for a reply — proving envelope sealing/verification, the Double
 * Ratchet, and MeshEngine's ops encoding are wire-compatible in both
 * directions, not just reviewed-to-match on paper.
 *
 * Run: pnpm exec tsx packages/sync/scripts/interop-with-android.ts <handoff-file-path>
 * Then, separately, run the Kotlin side (InteropSmoke.kt) pointed at the
 * same handoff file — see docs/Android.md for the exact command.
 */
import "fake-indexeddb/auto";
import { writeFile } from "node:fs/promises";
import {
  exportEncryptionPublicKey,
  exportPublicKey,
  exportRawWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  sign,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { MeshEngine } from "../src/engine.js";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import { toBase64, type DeviceInfo, type DeviceType } from "@screenmesh/protocol";

const SERVER = "http://127.0.0.1:8787/api";
const RELAY = "ws://127.0.0.1:8787/api/relay";

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
}

async function waitFor(label: string, timeoutMs: number, cond: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function info(identity: DeviceIdentity, name: string, type: DeviceType): Promise<DeviceInfo> {
  return {
    id: identity.deviceId,
    name,
    publicKey: await exportPublicKey(identity.publicKey),
    encryptionKey: await exportEncryptionPublicKey(identity.encryptionPublicKey),
    type,
  };
}

async function main(): Promise<void> {
  const handoffPath = process.argv[2];
  if (!handoffPath) throw new Error("usage: interop-with-android.ts <handoff-file-path>");

  const a = await generateIdentity();
  const workspaceKey = await generateWorkspaceKey();
  const workspaceId = crypto.randomUUID();
  const pairingToken = crypto.randomUUID();

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "android-interop", createdAt: Date.now() },
    device: await info(a, "TS Device A", "laptop"),
    pairingToken,
    tokenExpiresAt: Date.now() + 10 * 60_000,
  });
  console.log(`[1/5] workspace ${workspaceId} created (owner ${a.deviceId})`);

  await writeFile(
    handoffPath,
    JSON.stringify({
      serverUrl: SERVER,
      workspaceId,
      pairingToken,
      workspaceKeyB64: toBase64(await exportRawWorkspaceKey(workspaceKey)),
    }),
    "utf-8",
  );
  console.log(`[2/5] handoff written to ${handoffPath} — start the Kotlin side now`);

  const db = new ScreenMeshDb("interop-a");
  const transport = new WebSocketRelayTransport(RELAY, {
    deviceId: a.deviceId,
    workspaceId,
    sign: (data) => sign(a, data),
  });
  const engine = new MeshEngine({
    db,
    identity: a,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport,
  });
  await engine.start();

  let androidDeviceId: string | null = null;
  await waitFor("the Kotlin device to join and come online", 180_000, async () => {
    const devices = await db.devices.toArray();
    const other = devices.find((d) => d.id !== a.deviceId && d.status === "online");
    if (other) androidDeviceId = other.id;
    return !!other;
  });
  console.log(`[3/5] Kotlin device ${androidDeviceId} is online`);

  const greeting = await engine.sendObject(
    { type: "text", content: { text: "hello from TypeScript" } },
    [androidDeviceId!],
  );
  console.log("[4/5] sent greeting to Kotlin device, waiting for its reply...");

  let replyText: string | null = null;
  await waitFor("a reply object from the Kotlin device", 60_000, async () => {
    const objects = await db.objects.toArray();
    const reply = objects.find((o) => o.id !== greeting.id && o.createdBy === androidDeviceId);
    if (reply) replyText = (reply.content as { text: string }).text;
    return !!reply;
  });
  console.log(`[5/5] received reply from Kotlin device: "${replyText}"`);

  await engine.stop();
  console.log("ANDROID INTEROP OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("ANDROID INTEROP FAILED:", err);
  process.exit(1);
});
