/**
 * Full-stack engine smoke test against a running relay server:
 * three MeshEngines (IndexedDB via fake-indexeddb) exchange objects and
 * exercise the delivery lifecycle, file content, revocation, key
 * rotation, expiring objects, delivery options, and store-carry-forward.
 *
 * Run: pnpm exec tsx packages/sync/scripts/engine-smoke.ts
 */
import "fake-indexeddb/auto";
import {
  exportEncryptionPublicKey,
  exportPublicKey,
  generateIdentity,
  generateWorkspaceKey,
  sealEnvelope,
  sign,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import { MeshEngine } from "../src/engine.js";
import {
  DEFAULT_HOP_LIMIT,
  envelopeToJson,
  type DeviceInfo,
  type DeviceType,
} from "@screenmesh/protocol";

/** Short so tests observe expiry/carry sweeps without waiting ~15s. */
const TEST_SWEEP_INTERVAL_MS = 500;

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
    sweepIntervalMs: TEST_SWEEP_INTERVAL_MS,
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
  console.log("[1/16] workspace registered with three devices");

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
  console.log("[2/16] all engines connected, presence synced");

  const object = await ea.engine.sendObject(
    { type: "code", content: { text: "pnpm run integration-test" } },
    [b.deviceId],
  );
  await waitFor("object to reach B", async () => !!(await eb.db.objects.get(object.id)));
  const received = await eb.db.objects.get(object.id);
  if ((received?.content as { text: string }).text !== "pnpm run integration-test") {
    throw new Error("content mismatch");
  }
  console.log("[3/16] object created on A appeared decrypted on B");

  await waitFor("delivery ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "delivered";
  });
  console.log("[4/16] A's delivery status advanced to delivered");

  await eb.engine.markOpened(object.id);
  await waitFor("opened ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "opened";
  });
  console.log("[5/16] opened receipt propagated back to A");

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
  console.log("[6/16] image object with binary content arrived intact");

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
  console.log("[7/16] checklist toggled on B synced back to A");

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
  console.log("[8/16] concurrent Yjs edits merged identically on both devices");

  // Continue-on-device: A hands the note to B, which gets a focus request.
  await ea.engine.continueOnDevice(note.id, b.deviceId);
  await waitFor("focus request on B", async () => {
    const focus = await eb.db.settings.get("focusObject");
    return (focus?.value as { objectId: string } | undefined)?.objectId === note.id;
  });
  console.log("[9/16] continue-on-device focus request arrived on B");

  // Expiring objects: swept away on both ends once expiresAt passes.
  const expiring = await ea.engine.sendObject(
    { type: "text", content: { text: "self-destructing note" } },
    [b.deviceId],
    { expiresAt: Date.now() + 1200 },
  );
  await waitFor("expiring note to reach B", async () => !!(await eb.db.objects.get(expiring.id)));
  await waitFor("expiring note swept on A", async () => !(await ea.db.objects.get(expiring.id)));
  await waitFor("expiring note swept on B", async () => !(await eb.db.objects.get(expiring.id)));
  await waitFor("A's delivery marked expired", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(expiring.id).first();
    return delivery?.status === "expired";
  });
  console.log("[10/16] expiring object swept from both devices, delivery marked expired");

  // deleteAfterOpening: recipient's copy vanishes right after markOpened.
  const selfDestruct = await ea.engine.sendObject(
    { type: "text", content: { text: "read once" } },
    [b.deviceId],
    { deleteAfterOpening: true },
  );
  await waitFor("read-once note to reach B", async () => !!(await eb.db.objects.get(selfDestruct.id)));
  await eb.engine.markOpened(selfDestruct.id);
  await waitFor("A sees it opened", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(selfDestruct.id).first();
    return delivery?.status === "opened";
  });
  if (await eb.db.objects.get(selfDestruct.id)) {
    throw new Error("deleteAfterOpening did not remove the object on the recipient");
  }
  console.log("[11/16] deleteAfterOpening removed B's copy right after opening");

  // requireConfirmation + accept: gated as "pending" until B explicitly accepts.
  const gated = await ea.engine.sendObject(
    { type: "text", content: { text: "please confirm" } },
    [b.deviceId],
    { requireConfirmation: true },
  );
  await waitFor("gated note to reach B", async () => !!(await eb.db.objects.get(gated.id)));
  const gatedOnB = await eb.db.deliveries.where("objectId").equals(gated.id).first();
  if (gatedOnB?.status !== "pending") {
    throw new Error(`expected B's delivery to be pending, got ${gatedOnB?.status}`);
  }
  const gatedOnAPreAccept = await ea.db.deliveries.where("objectId").equals(gated.id).first();
  if (gatedOnAPreAccept?.status === "delivered") {
    throw new Error("A should not see 'delivered' before B accepts");
  }
  await eb.engine.acceptObject(gated.id);
  await waitFor("A sees the accepted delivery", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(gated.id).first();
    return delivery?.status === "delivered";
  });
  console.log("[12/16] requireConfirmation gated delivery until accepted");

  // requireConfirmation + reject: B declines, A is told, B keeps nothing.
  const declined = await ea.engine.sendObject(
    { type: "text", content: { text: "please confirm (this one gets rejected)" } },
    [b.deviceId],
    { requireConfirmation: true },
  );
  await waitFor("declined note to reach B", async () => !!(await eb.db.objects.get(declined.id)));
  await eb.engine.rejectObject(declined.id);
  await waitFor("A sees the rejection", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(declined.id).first();
    return delivery?.status === "rejected";
  });
  if (await eb.db.objects.get(declined.id)) {
    throw new Error("rejectObject should have removed B's local copy");
  }
  console.log("[13/16] requireConfirmation reject notified A and cleared B's copy");

  // Store–carry–forward: simulate a bundle addressed to C that couldn't be
  // delivered directly (e.g. sender had no route at send time) by sealing
  // it and dropping it straight into A's outbox — exactly the shape
  // sendObject would have produced. B (online, not the destination) should
  // pick it up as a carrier via the periodic sweep, and forward it to C.
  const carriedObjectId = crypto.randomUUID();
  const carriedObject = {
    id: carriedObjectId,
    workspaceId,
    type: "text" as const,
    content: { text: "carried via B" },
    createdBy: a.deviceId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const carryEnvelope = await sealEnvelope({
    identity: a,
    recipientDeviceId: c.deviceId,
    workspaceId,
    workspaceKey,
    plaintext: new TextEncoder().encode(
      JSON.stringify({
        ops: [
          {
            operationId: crypto.randomUUID(),
            deviceId: a.deviceId,
            workspaceId,
            type: "CREATE_OBJECT",
            objectId: carriedObjectId,
            timestamp: Date.now(),
            payload: { object: carriedObject },
          },
        ],
      }),
    ),
    sequenceNumber: 999999,
    createdAt: Date.now(),
  });
  const carryBytes = new TextEncoder().encode(JSON.stringify(envelopeToJson(carryEnvelope)));
  await ea.db.outbox.add({
    bundleId: carryEnvelope.messageId,
    sourceDeviceId: a.deviceId,
    destinationDeviceId: c.deviceId,
    workspaceId,
    encryptedPayload: carryBytes,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hopLimit: DEFAULT_HOP_LIMIT,
    signature: carryEnvelope.signature,
    offeredTo: [],
  });
  await waitFor("B picks up the bundle as a carrier", async () => {
    return !!(await eb.db.carried.get(carryEnvelope.messageId));
  });
  await waitFor("A's outbox records the hand-off", async () => {
    const bundle = await ea.db.outbox.get(carryEnvelope.messageId);
    return !!bundle?.offeredTo?.includes(b.deviceId) && bundle.hopLimit === DEFAULT_HOP_LIMIT - 1;
  });
  await waitFor("C receives the carried object from B", async () => {
    return !!(await ec.db.objects.get(carriedObjectId));
  });
  const carriedOnC = await ec.db.objects.get(carriedObjectId);
  if ((carriedOnC?.content as { text: string })?.text !== "carried via B") {
    throw new Error("carried object content mismatch on C");
  }
  await waitFor("B's carried copy is cleared after forwarding", async () => {
    return !(await eb.db.carried.get(carryEnvelope.messageId));
  });
  console.log("[14/16] store-carry-forward: B carried A's bundle and delivered it to C");

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
  console.log("[15/16] revoked device rejected by relay and pruned from roster");

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
  console.log("[16/16] workspace key rotated; B decrypts epoch-1 traffic, C is locked out");

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
