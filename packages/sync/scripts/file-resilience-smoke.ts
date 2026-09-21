/**
 * Focused smoke test for the chunked-file-drop reliability fix: durable
 * chunk persistence (survives a simulated reload mid-transfer) and
 * stall-triggered resend of unacked chunks. Two devices only, paired with
 * a single token (the workspace-creation token), so it doesn't depend on
 * the pairing-token *rotation* endpoint the general engine-smoke.ts script
 * also exercises.
 *
 * Run: pnpm exec tsx packages/sync/scripts/file-resilience-smoke.ts
 * (relay server must already be running on 127.0.0.1:8787)
 */
import "fake-indexeddb/auto";
import {
  exportEncryptionPublicKey,
  exportPublicKey,
  generateIdentity,
  generateWorkspaceKey,
  sign,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import { MeshEngine } from "../src/engine.js";
import type { DeviceInfo, DeviceType } from "@screenmesh/protocol";

const TEST_SWEEP_INTERVAL_MS = 300;
const TEST_STALL_MS = 1500;
const TEST_FAIL_MS = 30_000;

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

async function waitFor(label: string, cond: () => Promise<boolean>, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
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

function makeTransport(identity: DeviceIdentity, workspaceId: string): WebSocketRelayTransport {
  return new WebSocketRelayTransport(RELAY, {
    deviceId: identity.deviceId,
    workspaceId,
    sign: (data) => sign(identity, data),
  });
}

async function main(): Promise<void> {
  const a = await generateIdentity(); // sender ("laptop")
  const b = await generateIdentity(); // receiver ("phone")
  const workspaceKey = await generateWorkspaceKey();
  const workspaceId = crypto.randomUUID();
  const token = crypto.randomUUID();

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "file-resilience-smoke", createdAt: Date.now() },
    device: await info(a, "Laptop", "laptop"),
    pairingToken: token,
    tokenExpiresAt: Date.now() + 60_000,
  });
  await post(`${SERVER}/workspaces/${workspaceId}/join`, {
    pairingToken: token,
    device: await info(b, "Phone", "phone"),
  });
  console.log("[1/6] workspace registered with two devices");

  const dbA = new ScreenMeshDb("resilience-a");
  const engineA = new MeshEngine({
    db: dbA,
    identity: a,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport: makeTransport(a, workspaceId),
    sweepIntervalMs: TEST_SWEEP_INTERVAL_MS,
    fileTransferStallMs: TEST_STALL_MS,
    fileTransferFailMs: TEST_FAIL_MS,
  });

  const dbB = new ScreenMeshDb("resilience-b");
  let engineB = new MeshEngine({
    db: dbB,
    identity: b,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport: makeTransport(b, workspaceId),
    sweepIntervalMs: TEST_SWEEP_INTERVAL_MS,
  });

  await engineA.start();
  await engineB.start();
  await waitFor("presence synced", async () => (await dbA.devices.count()) === 2 && (await dbB.devices.count()) === 2);
  console.log("[2/6] both engines connected, presence synced");

  // A sizable file: big enough for a meaningful number of chunks (~200KB
  // base64 each) so there's a wide-enough window to reliably interrupt B
  // partway through, even though both engines share this one Node process.
  const raw = new Uint8Array(8_000_000);
  for (let i = 0; i < raw.length; i += 65536) crypto.getRandomValues(raw.subarray(i, Math.min(i + 65536, raw.length)));
  const dataB64 = Buffer.from(raw).toString("base64");
  const totalChunks = Math.ceil(dataB64.length / 200_000);
  console.log(`    sending ${(raw.length / 1e6).toFixed(1)}MB file as ${totalChunks} chunks`);

  const sendPromise = engineA.sendObject(
    { type: "file", content: { name: "video.bin", mimeType: "application/octet-stream", size: raw.length, dataB64 } },
    [b.deviceId],
  );

  // Interrupt B partway through: stop its engine (simulating the tab being
  // backgrounded/killed) as soon as it has durably persisted SOME chunks
  // but not all — proving the persisted buffer, not the in-memory one, is
  // what survives. Tight poll: both engines share this process, so racing
  // against A's fire-and-forget send loop needs fine-grained timing.
  let fileId: string | null = null;
  let persistedBeforeStop = 0;
  for (let i = 0; i < 2000; i++) {
    const objects = await dbA.objects.toArray();
    const fileObj = objects.find((o) => o.type === "file");
    if (fileObj) {
      fileId = fileObj.id;
      const persisted = await dbB.fileChunks.where("fileId").equals(fileObj.id).count();
      if (persisted > 0 && persisted < totalChunks) {
        persistedBeforeStop = persisted;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!fileId || persistedBeforeStop === 0) throw new Error("never observed B mid-transfer — file sent faster than the test could interrupt it; increase raw size");
  await engineB.stop();
  const file = await sendPromise;
  console.log(`[3/6] interrupted B after persisting ${persistedBeforeStop}/${totalChunks} chunks (simulated backgrounding/reload)`);

  if (await dbB.objects.get(file.id)) throw new Error("file should NOT be fully assembled yet — test interrupted too late to be meaningful");

  // "Reload": a fresh MeshEngine instance over the SAME local db, exactly
  // like a page reload — this is the scenario the old in-memory-only
  // incomingChunks Map could never survive.
  engineB = new MeshEngine({
    db: dbB,
    identity: b,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport: makeTransport(b, workspaceId),
    sweepIntervalMs: TEST_SWEEP_INTERVAL_MS,
  });
  await engineB.start();
  const persistedAfterRestart = await dbB.fileChunks.where("fileId").equals(file.id).count();
  if (persistedAfterRestart < persistedBeforeStop) {
    throw new Error(`rehydrate lost progress: had ${persistedBeforeStop} chunks persisted, only ${persistedAfterRestart} after restart`);
  }
  console.log(`[4/6] "reloaded" B — rehydrated with ${persistedAfterRestart}/${totalChunks} chunks already durable, none lost`);

  // A's stall-retry sweep should notice the unacked chunks (B never acked
  // the ones it received after being stopped mid-flight — the ack for
  // those either never went out or B's transport was down) and resend them
  // now that B is back online, completing the transfer without any manual
  // action.
  await waitFor("file fully reassembles on B after A's automatic resend", async () => !!(await dbB.objects.get(file.id)), 150);
  const onB = await dbB.objects.get(file.id);
  const contentB = onB?.content as { dataB64: string };
  if (contentB.dataB64 !== dataB64) throw new Error("reassembled file content mismatch after resend");
  console.log("[5/6] transfer completed byte-for-byte after automatic resend of missing chunks — no data loss, no manual retry needed");

  await waitFor("A's delivery marked delivered", async () => {
    const delivery = await dbA.deliveries.where("objectId").equals(file.id).first();
    return delivery?.status === "delivered";
  });
  const finalDelivery = await dbA.deliveries.where("objectId").equals(file.id).first();
  if (!finalDelivery?.chunkProgress || finalDelivery.chunkProgress.ackedChunks.length !== totalChunks) {
    throw new Error(`expected full chunk ack progress on A, got ${JSON.stringify(finalDelivery?.chunkProgress)}`);
  }
  console.log("[6/6] A's delivery status advanced to delivered with full chunk-ack progress recorded");

  await engineA.stop();
  await engineB.stop();
  console.log("FILE RESILIENCE SMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
