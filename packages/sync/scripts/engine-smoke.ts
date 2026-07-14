/**
 * Full-stack engine smoke test against a running relay server:
 * three MeshEngines (IndexedDB via fake-indexeddb) exchange objects and
 * exercise the delivery lifecycle, file content, revocation, and
 * workspace-key rotation.
 *
 * Run: pnpm exec tsx packages/sync/scripts/engine-smoke.ts
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

async function info(
  identity: DeviceIdentity,
  name: string,
  type: DeviceType,
): Promise<DeviceInfo> {
  return {
    id: identity.deviceId,
    name,
    publicKey: await exportPublicKey(identity.publicKey),
    encryptionKey: await exportEncryptionPublicKey(identity.encryptionPublicKey),
    type,
  };
}

async function makeEngine(
  identity: DeviceIdentity,
  dbName: string,
  workspaceId: string,
  workspaceKey: CryptoKey,
  ownerDeviceId: string,
): Promise<{ engine: MeshEngine; db: ScreenMeshDb }> {
  const db = new ScreenMeshDb(dbName);
  const transport = new WebSocketRelayTransport(RELAY, {
    deviceId: identity.deviceId,
    workspaceId,
    sign: (data) => sign(identity, data),
  });
  const engine = new MeshEngine({
    db,
    identity,
    workspaceId,
    workspaceKey,
    ownerDeviceId,
    transport,
  });
  return { engine, db };
}

async function main(): Promise<void> {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const c = await generateIdentity();
  const workspaceKey = await generateWorkspaceKey();
  const workspaceId = crypto.randomUUID();
  const token1 = crypto.randomUUID();
  const token2 = crypto.randomUUID();

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "engine-smoke", createdAt: Date.now() },
    device: await info(a, "Engine A", "laptop"),
    pairingToken: token1,
    tokenExpiresAt: Date.now() + 60_000,
  });
  await post(`${SERVER}/workspaces/${workspaceId}/join`, {
    pairingToken: token1,
    device: await info(b, "Engine B", "phone"),
  });
  await post(`${SERVER}/workspaces/${workspaceId}/pairing-token`, {
    deviceId: a.deviceId,
    pairingToken: token2,
    tokenExpiresAt: Date.now() + 60_000,
  });
  await post(`${SERVER}/workspaces/${workspaceId}/join`, {
    pairingToken: token2,
    device: await info(c, "Engine C", "tablet"),
  });
  console.log("[1/11] workspace registered with three devices");

  const ea = await makeEngine(a, "engine-a", workspaceId, workspaceKey, a.deviceId);
  const eb = await makeEngine(b, "engine-b", workspaceId, workspaceKey, a.deviceId);
  const ec = await makeEngine(c, "engine-c", workspaceId, workspaceKey, a.deviceId);
  await ea.engine.start();
  await eb.engine.start();
  await ec.engine.start();

  await waitFor("presence rosters", async () => {
    return (
      (await ea.db.devices.count()) === 3 &&
      (await eb.db.devices.count()) === 3 &&
      (await ec.db.devices.count()) === 3
    );
  });
  console.log("[2/11] all engines connected, presence synced");

  const object = await ea.engine.sendObject(
    { type: "code", content: { text: "pnpm run integration-test" } },
    [b.deviceId],
  );
  await waitFor("object to reach B", async () => !!(await eb.db.objects.get(object.id)));
  const received = await eb.db.objects.get(object.id);
  if ((received?.content as { text: string }).text !== "pnpm run integration-test") {
    throw new Error("content mismatch");
  }
  console.log("[3/11] object created on A appeared decrypted on B");

  await waitFor("delivery ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "delivered";
  });
  console.log("[4/11] A's delivery status advanced to delivered");

  await eb.engine.markOpened(object.id);
  await waitFor("opened ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "opened";
  });
  console.log("[5/11] opened receipt propagated back to A");

  const pixels = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  const image = await ea.engine.sendObject(
    {
      type: "image",
      content: {
        name: "screenshot.png",
        mimeType: "image/png",
        size: pixels.length,
        dataB64: pixels.toString("base64"),
      },
    },
    [b.deviceId],
  );
  await waitFor("image to reach B", async () => !!(await eb.db.objects.get(image.id)));
  const receivedImage = await eb.db.objects.get(image.id);
  if ((receivedImage?.content as { dataB64: string }).dataB64 !== pixels.toString("base64")) {
    throw new Error("image bytes corrupted in transit");
  }
  console.log("[6/11] image object with binary content arrived intact");

  // Checklist: created on A, toggled on B, LWW-merged back on A.
  const checklist = await ea.engine.sendObject(
    {
      type: "checklist",
      content: {
        items: [
          { id: "i1", text: "write tests", done: false },
          { id: "i2", text: "ship it", done: false },
        ],
      },
    },
    [b.deviceId],
  );
  await waitFor("checklist to reach B", async () => !!(await eb.db.objects.get(checklist.id)));
  await eb.engine.updateObjectContent(checklist.id, {
    items: [
      { id: "i1", text: "write tests", done: true },
      { id: "i2", text: "ship it", done: false },
    ],
  });
  await waitFor("toggle to reach A", async () => {
    const obj = await ea.db.objects.get(checklist.id);
    const items = (obj?.content as { items: Array<{ id: string; done: boolean }> })?.items;
    return items?.find((i) => i.id === "i1")?.done === true;
  });
  console.log("[7/11] checklist toggled on B synced back to A");

  // Yjs: concurrent edits on A and B merge instead of overwriting.
  const note = await ea.engine.sendObject(
    { type: "text", content: { text: "shared note" } },
    [b.deviceId],
  );
  await waitFor("note to reach B", async () => !!(await eb.db.objects.get(note.id)));
  await Promise.all([
    ea.engine.editText(note.id, "PREFIX shared note"),
    eb.engine.editText(note.id, "shared note SUFFIX"),
  ]);
  await waitFor("concurrent edits to converge", async () => {
    const onA = ((await ea.db.objects.get(note.id))?.content as { text: string })?.text;
    const onB = ((await eb.db.objects.get(note.id))?.content as { text: string })?.text;
    return (
      !!onA &&
      onA === onB &&
      onA.includes("PREFIX") &&
      onA.includes("SUFFIX") &&
      onA.includes("shared note")
    );
  });
  console.log("[8/11] concurrent Yjs edits merged identically on both devices");

  // Continue-on-device: A hands the note to B, which gets a focus request.
  await ea.engine.continueOnDevice(note.id, b.deviceId);
  await waitFor("focus request on B", async () => {
    const focus = await eb.db.settings.get("focusObject");
    return (focus?.value as { objectId: string } | undefined)?.objectId === note.id;
  });
  console.log("[9/11] continue-on-device focus request arrived on B");

  // Revoke C, then rotate the workspace key.
  const revokeRes = await fetch(`${SERVER}/workspaces/${workspaceId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerDeviceId: a.deviceId, deviceId: c.deviceId }),
  });
  if (!revokeRes.ok) throw new Error(`revoke failed: ${revokeRes.status}`);
  await ea.engine.revokeDevice(c.deviceId);
  const newEpoch = await ea.engine.rotateWorkspaceKey();
  if (newEpoch !== 1) throw new Error(`expected epoch 1, got ${newEpoch}`);

  const tcRevoked = new WebSocketRelayTransport(RELAY, {
    deviceId: c.deviceId,
    workspaceId,
    sign: (data) => sign(c, data),
  });
  let authRejected = false;
  try {
    await tcRevoked.open();
  } catch (err) {
    authRejected = String(err).includes("not registered");
  }
  if (!authRejected) throw new Error("revoked device was still able to authenticate");
  await waitFor("C removed from A's roster", async () => {
    return !(await ea.db.devices.get(c.deviceId));
  });
  console.log("[10/11] revoked device rejected by relay and pruned from roster");

  // B must have adopted epoch 1 via the ECDH-wrapped ROTATE_KEY op:
  // a fresh object from A (sealed under epoch 1) must still decrypt on B.
  const postRotation = await ea.engine.sendObject(
    { type: "text", content: { text: "sealed under the rotated key" } },
    [b.deviceId],
  );
  await waitFor("post-rotation object to reach B", async () => {
    return !!(await eb.db.objects.get(postRotation.id));
  });
  const rotatedObj = await eb.db.objects.get(postRotation.id);
  if ((rotatedObj?.content as { text: string }).text !== "sealed under the rotated key") {
    throw new Error("post-rotation content mismatch");
  }
  console.log("[11/11] workspace key rotated; B decrypts epoch-1 traffic, C is locked out");

  await ea.engine.stop();
  await eb.engine.stop();
  await ec.engine.stop();
  console.log("ENGINE SMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
