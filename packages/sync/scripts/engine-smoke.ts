/**
 * Full-stack engine smoke test against a running relay server:
 * three MeshEngines (IndexedDB via fake-indexeddb) exchange objects and
 * exercise the delivery lifecycle, file content, revocation, per-pair
 * Double Ratchet encryption, expiring objects, delivery options,
 * store-carry-forward, chunked file drop, the clipboard tunnel, and
 * capability routing.
 *
 * Run: pnpm exec tsx packages/sync/scripts/engine-smoke.ts
 */
import "fake-indexeddb/auto";
import {
  exportEncryptionPublicKey,
  exportPublicKey,
  exportRawWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  initRatchetSession,
  ratchetEncrypt,
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
): Promise<{ engine: MeshEngine; db: ScreenMeshDb; transport: WebSocketRelayTransport }> {
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
  return { engine, db, transport };
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
  console.log("[1/19] workspace registered with three devices");

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
  console.log("[2/19] all engines connected, presence synced");

  // Stop C's engine right away: everything through step 13 only involves
  // A and B, but broadcastOps (editText/updateObjectContent) sends to
  // EVERY device in the roster, including C — and sendOps/deliverBytes
  // treats "the relay accepted it" as delivered live regardless of the
  // RECIPIENT's status, so those sends land in the relay's OWN
  // server-side queue for C, not A/B's local outbox. Left alone, that
  // queued traffic would still land on C the moment it reconnects,
  // conflicting with the carry test below (which relies on this being
  // A's genuinely FIRST-EVER message to C to exercise the ratchet's
  // identity-key bootstrap). Removing C from A/B's LOCAL roster is a
  // test-only simulation of "C isn't part of this conversation yet" —
  // presence naturally reintroduces it when it reconnects for the carry
  // test, exactly like a real device joining a live workspace.
  await ec.engine.stop();
  await waitFor("C shows offline on A and B", async () => {
    return (
      (await ea.db.devices.get(c.deviceId))?.status === "offline" &&
      (await eb.db.devices.get(c.deviceId))?.status === "offline"
    );
  });
  await ea.db.devices.delete(c.deviceId);
  await eb.db.devices.delete(c.deviceId);

  const object = await ea.engine.sendObject(
    { type: "code", content: { text: "pnpm run integration-test" } },
    [b.deviceId],
  );
  await waitFor("object to reach B", async () => !!(await eb.db.objects.get(object.id)));
  const received = await eb.db.objects.get(object.id);
  if ((received?.content as { text: string }).text !== "pnpm run integration-test") {
    throw new Error("content mismatch");
  }
  console.log("[3/19] object created on A appeared decrypted on B");

  await waitFor("delivery ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "delivered";
  });
  console.log("[4/19] A's delivery status advanced to delivered");

  await eb.engine.markOpened(object.id);
  await waitFor("opened ack on A", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(object.id).first();
    return delivery?.status === "opened";
  });
  console.log("[5/19] opened receipt propagated back to A");

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
  console.log("[6/19] image object with binary content arrived intact");

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
  console.log("[7/19] checklist toggled on B synced back to A");

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
  console.log("[8/19] concurrent Yjs edits merged identically on both devices");

  // Continue-on-device: A hands the note to B, which gets a focus request.
  await ea.engine.continueOnDevice(note.id, b.deviceId);
  await waitFor("focus request on B", async () => {
    const focus = await eb.db.settings.get("focusObject");
    return (focus?.value as { objectId: string } | undefined)?.objectId === note.id;
  });
  console.log("[9/19] continue-on-device focus request arrived on B");

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
  console.log("[10/19] expiring object swept from both devices, delivery marked expired");

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
  console.log("[11/19] deleteAfterOpening removed B's copy right after opening");

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
  console.log("[12/19] requireConfirmation gated delivery until accepted");

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
  console.log("[13/19] requireConfirmation reject notified A and cleared B's copy");

  // Store–carry–forward. The relay's OWN server-side queue already
  // covers "recipient offline, sender/relay fine" (Phase 1) — any send
  // A's transport can hand to the relay counts as delivered live, so it
  // never touches A's LOCAL outbox regardless of whether the RECIPIENT
  // is online. Carry-forward exists for when the relay itself can't be
  // reached from the sender at all (a lost relay-side queue on restart,
  // a flaky connection) — simulate that by sealing a bundle exactly the
  // way sendObject would and dropping it straight into A's outbox,
  // exactly the shape a failed live send produces. C has been offline
  // since step 2 (see above), so this is also A's VERY FIRST message
  // ever to C, exercising the ratchet's identity-key bootstrap end to
  // end, through a carrier hop.
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
  const sessionAtoC = await initRatchetSession({
    workspaceId,
    myDeviceId: a.deviceId,
    myIdentityPublic: a.encryptionPublicKey,
    myIdentityPrivate: a.encryptionPrivateKey,
    peerDeviceId: c.deviceId,
    peerIdentityPublic: c.encryptionPublicKey,
    pairingSecret: await exportRawWorkspaceKey(workspaceKey),
  });
  const { messageKey, header } = await ratchetEncrypt(sessionAtoC);
  const carryEnvelope = await sealEnvelope({
    identity: a,
    recipientDeviceId: c.deviceId,
    workspaceId,
    messageKey,
    ratchetHeader: header,
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

  // Fresh engine + transport, but the SAME local db — simulates the same
  // physical device reconnecting, not a brand-new one.
  const cTransport2 = new WebSocketRelayTransport(RELAY, {
    deviceId: c.deviceId,
    workspaceId,
    sign: (data) => sign(c, data),
  });
  ec.engine = new MeshEngine({
    db: ec.db,
    identity: c,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport: cTransport2,
    sweepIntervalMs: TEST_SWEEP_INTERVAL_MS,
  });
  await ec.engine.start();
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
  console.log("[14/19] store-carry-forward: B carried A's first-ever message to C and delivered it");

  // Secure file drop: a file whose base64 payload exceeds the chunk
  // threshold travels as a sequence of FILE_CHUNK envelopes, reassembled
  // on arrival only once every chunk is present.
  const bigRaw = new Uint8Array(400_000); // well past FILE_CHUNK_THRESHOLD_B64
  for (let i = 0; i < bigRaw.length; i += 65536) {
    crypto.getRandomValues(bigRaw.subarray(i, Math.min(i + 65536, bigRaw.length)));
  }
  const bigB64 = Buffer.from(bigRaw).toString("base64");
  const bigFile = await ea.engine.sendObject(
    {
      type: "file",
      content: { name: "big.bin", mimeType: "application/octet-stream", size: bigRaw.length, dataB64: bigB64 },
    },
    [b.deviceId],
  );
  await waitFor("chunked file fully reassembled on B", async () => {
    return !!(await eb.db.objects.get(bigFile.id));
  });
  const bigOnB = await eb.db.objects.get(bigFile.id);
  const bigContent = bigOnB?.content as { dataB64: string; name: string };
  if (bigContent.dataB64 !== bigB64 || bigContent.dataB64.length !== bigB64.length) {
    throw new Error("chunked file did not reassemble byte-for-byte");
  }
  await waitFor("A sees the chunked file delivered", async () => {
    const delivery = await ea.db.deliveries.where("objectId").equals(bigFile.id).first();
    return delivery?.status === "delivered";
  });
  console.log("[15/19] secure file drop: large file chunked, reassembled byte-for-byte, delivery acked");

  // Temporary clipboard tunnel: same expiring-object + deleteAfterOpening
  // machinery as Phase 2, just a dedicated content type.
  const clip = await ea.engine.sendObject(
    { type: "clipboard", content: { text: "ssh mykey@server.example" } },
    [b.deviceId],
    { expiresAt: Date.now() + 60_000, deleteAfterOpening: true },
  );
  await waitFor("clipboard share reaches B", async () => !!(await eb.db.objects.get(clip.id)));
  const clipOnB = await eb.db.objects.get(clip.id);
  if ((clipOnB?.content as { text: string })?.text !== "ssh mykey@server.example") {
    throw new Error("clipboard content mismatch on B");
  }
  await eb.engine.markOpened(clip.id);
  await waitFor("clipboard share erases itself on B after opening", async () => {
    return !(await eb.db.objects.get(clip.id));
  });
  console.log("[16/19] temporary clipboard tunnel: shared, received, erased on first paste");

  // Capability routing: B advertises "terminal" via the real HTTP API (so
  // it flows through the same presence path a real client would use); A
  // resolves it and gets B back, ranked online-first.
  await post(`${SERVER}/workspaces/${workspaceId}/capabilities`, {
    deviceId: b.deviceId,
    capabilities: ["terminal"],
  });
  await waitFor("A sees B's advertised capability", async () => {
    return !!(await ea.db.devices.get(b.deviceId))?.capabilities?.includes("terminal");
  });
  const resolved = await ea.engine.resolveCapability("terminal");
  if (resolved.length !== 1 || resolved[0]?.id !== b.deviceId) {
    throw new Error(`expected resolveCapability("terminal") to return only B, got ${JSON.stringify(resolved)}`);
  }
  if (resolved[0]?.status !== "online") {
    throw new Error("expected B to resolve as online");
  }
  console.log("[17/19] capability routing: A resolved \"terminal\" to B via presence-advertised capabilities");

  // Revoke C. Per-pair ratcheting means this needs no group-wide rekey —
  // the owner just drops the local ratchet session with C and the relay
  // refuses C's next connection; A-B's session is untouched by any of it.
  const revokeRes = await fetch(`${SERVER}/workspaces/${workspaceId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerDeviceId: a.deviceId, deviceId: c.deviceId }),
  });
  if (!revokeRes.ok) throw new Error(`revoke failed: ${revokeRes.status}`);
  await ea.engine.revokeDevice(c.deviceId);

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
  if (await ea.db.ratchets.get(c.deviceId)) {
    throw new Error("A's ratchet session with the revoked device should have been dropped");
  }
  console.log("[18/19] revoked device rejected by relay; A dropped its ratchet session with C");

  // Prove revocation is pairwise-isolated: A-B keeps working completely
  // unaffected — no rekey, no interruption, because their ratchet session
  // never involved C in the first place.
  const postRevocation = await ea.engine.sendObject(
    { type: "text", content: { text: "unaffected by C's revocation" } },
    [b.deviceId],
  );
  await waitFor("post-revocation object reaches B", async () => {
    return !!(await eb.db.objects.get(postRevocation.id));
  });
  const postRevocationObj = await eb.db.objects.get(postRevocation.id);
  if ((postRevocationObj?.content as { text: string }).text !== "unaffected by C's revocation") {
    throw new Error("post-revocation content mismatch");
  }
  console.log("[19/19] A-B ratchet session unaffected by C's revocation — no group rekey needed");

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
