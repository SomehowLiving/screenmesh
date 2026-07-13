/**
 * Full-stack engine smoke test against a running relay server:
 * two MeshEngines (IndexedDB via fake-indexeddb) exchange an object and
 * walk the delivery lifecycle queued → sending → delivered → opened.
 *
 * Run: pnpm exec tsx packages/sync/scripts/engine-smoke.ts
 */
import "fake-indexeddb/auto";
import {
  exportPublicKey,
  generateIdentity,
  generateWorkspaceKey,
  sign,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import { MeshEngine } from "../src/engine.js";
import type {
  CreateWorkspaceRequest,
  JoinWorkspaceRequest,
} from "@screenmesh/protocol";

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

async function waitFor(label: string, cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

async function makeEngine(
  identity: DeviceIdentity,
  dbName: string,
  workspaceId: string,
  workspaceKey: CryptoKey,
): Promise<{ engine: MeshEngine; db: ScreenMeshDb }> {
  const db = new ScreenMeshDb(dbName);
  const transport = new WebSocketRelayTransport(RELAY, {
    deviceId: identity.deviceId,
    workspaceId,
    sign: (data) => sign(identity, data),
  });
  const engine = new MeshEngine({ db, identity, workspaceId, workspaceKey, transport });
  return { engine, db };
}

async function main(): Promise<void> {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const workspaceKey = await generateWorkspaceKey();
  const workspaceId = crypto.randomUUID();
  const pairingToken = crypto.randomUUID();

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "engine-smoke", createdAt: Date.now() },
    device: {
      id: a.deviceId,
      name: "Engine A",
      publicKey: await exportPublicKey(a.publicKey),
      type: "laptop",
    },
    pairingToken,
    tokenExpiresAt: Date.now() + 60_000,
  } satisfies CreateWorkspaceRequest);
  await post(`${SERVER}/workspaces/${workspaceId}/join`, {
    pairingToken,
    device: {
      id: b.deviceId,
      name: "Engine B",
      publicKey: await exportPublicKey(b.publicKey),
      type: "phone",
    },
  } satisfies JoinWorkspaceRequest);
  console.log("[1/5] workspace registered");

  const ea = await makeEngine(a, "engine-a", workspaceId, workspaceKey);
  const eb = await makeEngine(b, "engine-b", workspaceId, workspaceKey);
  await ea.engine.start();
  await eb.engine.start();

  await waitFor("presence rosters", async () => {
    return (await ea.db.devices.count()) === 2 && (await eb.db.devices.count()) === 2;
  });
  console.log("[2/5] both engines connected, presence synced");

  const object = await ea.engine.sendObject(
    { type: "code", content: { text: "pnpm run integration-test" } },
    [b.deviceId],
  );

  await waitFor("object to reach B", async () => {
    const received = await eb.db.objects.get(object.id);
    return !!received;
  });
  const received = await eb.db.objects.get(object.id);
  const text = (received?.content as { text: string }).text;
  if (text !== "pnpm run integration-test") throw new Error("content mismatch");
  console.log("[3/5] object created on A appeared decrypted on B");

  await waitFor("delivery ack on A", async () => {
    const delivery = await ea.db.deliveries
      .where("objectId")
      .equals(object.id)
      .first();
    return delivery?.status === "delivered";
  });
  console.log("[4/5] A's delivery status advanced to delivered");

  await eb.engine.markOpened(object.id);
  await waitFor("opened ack on A", async () => {
    const delivery = await ea.db.deliveries
      .where("objectId")
      .equals(object.id)
      .first();
    return delivery?.status === "opened";
  });
  console.log("[5/5] opened receipt propagated back to A");

  await ea.engine.stop();
  await eb.engine.stop();
  console.log("ENGINE SMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
