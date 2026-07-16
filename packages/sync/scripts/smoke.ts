/**
 * End-to-end smoke test against a running relay server (pnpm dev:server):
 *   1. Device A creates a workspace; device B joins with the pairing token.
 *   2. Both authenticate to the relay by signing the server's nonce.
 *   3. A ratchet-seals an encrypted envelope to B; B receives, verifies, decrypts.
 *   4. B disconnects; A sends again; B reconnects and receives the queued
 *      envelope (store-and-forward).
 *
 * Run: pnpm exec tsx packages/sync/scripts/smoke.ts
 */
import {
  exportEncryptionPublicKey,
  exportPublicKey,
  exportRawWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  importPublicKey,
  initRatchetSession,
  ratchetDecrypt,
  ratchetEncrypt,
  sealEnvelope,
  sign,
  verifyEnvelope,
  decryptEnvelope,
  type RatchetSession,
} from "@screenmesh/crypto";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import {
  envelopeFromJson,
  envelopeToJson,
  type CreateWorkspaceRequest,
  type EnvelopeJson,
  type JoinWorkspaceRequest,
  type JoinWorkspaceResponse,
} from "@screenmesh/protocol";

const SERVER = "http://127.0.0.1:8787/api";
const RELAY = "ws://127.0.0.1:8787/api/relay";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms),
    ),
  ]);
}

function nextEnvelope(transport: WebSocketRelayTransport): Promise<EnvelopeJson> {
  return new Promise((resolve) => {
    transport.onMessage((data) => {
      resolve(JSON.parse(new TextDecoder().decode(data)) as EnvelopeJson);
    });
  });
}

async function main(): Promise<void> {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const aPub = await exportPublicKey(a.publicKey);
  const bPub = await exportPublicKey(b.publicKey);
  const aEncKey = await exportEncryptionPublicKey(a.encryptionPublicKey);
  const bEncKey = await exportEncryptionPublicKey(b.encryptionPublicKey);
  const pairingSecret = await exportRawWorkspaceKey(await generateWorkspaceKey());
  const workspaceId = crypto.randomUUID();
  const pairingToken = crypto.randomUUID();

  // 1. Register + join
  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "smoke", createdAt: Date.now() },
    device: { id: a.deviceId, name: "Device A", publicKey: aPub, encryptionKey: aEncKey, type: "laptop" },
    pairingToken,
    tokenExpiresAt: Date.now() + 60_000,
  } satisfies CreateWorkspaceRequest);

  const joined = await post<JoinWorkspaceResponse>(
    `${SERVER}/workspaces/${workspaceId}/join`,
    {
      pairingToken,
      device: { id: b.deviceId, name: "Device B", publicKey: bPub, encryptionKey: bEncKey, type: "phone" },
    } satisfies JoinWorkspaceRequest,
  );
  assert(joined.devices.length === 2, "join should report both devices");
  assert(joined.workspace.ownerDeviceId === a.deviceId, "owner should be device A");
  console.log("[1/4] workspace created and joined");

  // 2. Authenticated relay connections
  const ta = new WebSocketRelayTransport(RELAY, {
    deviceId: a.deviceId,
    workspaceId,
    sign: (data) => sign(a, data),
  });
  const tb = new WebSocketRelayTransport(RELAY, {
    deviceId: b.deviceId,
    workspaceId,
    sign: (data) => sign(b, data),
  });
  const firstDelivery = nextEnvelope(tb);
  await withTimeout(ta.open(), 5000, "A auth");
  await withTimeout(tb.open(), 5000, "B auth");
  let discovered = false;
  for (let i = 0; i < 20 && !discovered; i++) {
    const peersOfA = await ta.discover();
    discovered = peersOfA.some((p) => p.deviceId === b.deviceId);
    if (!discovered) await new Promise((r) => setTimeout(r, 200));
  }
  assert(discovered, "A should discover B online");
  console.log("[2/4] both devices authenticated to the relay");

  // A's and B's per-pair ratchet sessions (mirrors what MeshEngine does
  // internally — see packages/sync/src/engine.ts ratchetSessionFor).
  const sessionA: RatchetSession = await initRatchetSession({
    workspaceId,
    myDeviceId: a.deviceId,
    myIdentityPublic: a.encryptionPublicKey,
    myIdentityPrivate: a.encryptionPrivateKey,
    peerDeviceId: b.deviceId,
    peerIdentityPublic: b.encryptionPublicKey,
    pairingSecret,
  });
  const sessionB: RatchetSession = await initRatchetSession({
    workspaceId,
    myDeviceId: b.deviceId,
    myIdentityPublic: b.encryptionPublicKey,
    myIdentityPrivate: b.encryptionPrivateKey,
    peerDeviceId: a.deviceId,
    peerIdentityPublic: a.encryptionPublicKey,
    pairingSecret,
  });

  // 3. Live encrypted envelope A -> B
  const message1 = { ops: [{ hello: "from A", n: 1 }] };
  const enc1 = await ratchetEncrypt(sessionA);
  const env1 = await sealEnvelope({
    identity: a,
    recipientDeviceId: b.deviceId,
    workspaceId,
    messageKey: enc1.messageKey,
    ratchetHeader: enc1.header,
    plaintext: new TextEncoder().encode(JSON.stringify(message1)),
    sequenceNumber: 1,
    createdAt: Date.now(),
  });
  ta.sendEnvelope(envelopeToJson(env1));
  const receivedJson = await withTimeout(firstDelivery, 5000, "live envelope");
  const received1 = envelopeFromJson(receivedJson);
  await verifyEnvelope(received1, await importPublicKey(aPub), Date.now());
  const key1 = await ratchetDecrypt(sessionB, {
    ratchetPublicKeyB64: received1.ratchetPublicKeyB64,
    messageNumber: received1.messageNumber,
    previousChainLength: received1.previousChainLength,
  });
  const opened1 = await decryptEnvelope(received1, key1);
  assert(
    new TextDecoder().decode(opened1) === JSON.stringify(message1),
    "decrypted payload should match",
  );
  console.log("[3/4] live envelope delivered, verified, and decrypted");

  // 4. Store-and-forward: B offline, A sends, B reconnects
  await tb.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const message2 = { ops: [{ hello: "queued for B", n: 2 }] };
  const enc2 = await ratchetEncrypt(sessionA);
  const env2 = await sealEnvelope({
    identity: a,
    recipientDeviceId: b.deviceId,
    workspaceId,
    messageKey: enc2.messageKey,
    ratchetHeader: enc2.header,
    plaintext: new TextEncoder().encode(JSON.stringify(message2)),
    sequenceNumber: 2,
    createdAt: Date.now(),
  });
  ta.sendEnvelope(envelopeToJson(env2));
  await new Promise((r) => setTimeout(r, 300));

  const tb2 = new WebSocketRelayTransport(RELAY, {
    deviceId: b.deviceId,
    workspaceId,
    sign: (data) => sign(b, data),
  });
  const queuedDelivery = nextEnvelope(tb2);
  await withTimeout(tb2.open(), 5000, "B re-auth");
  const queuedJson = await withTimeout(queuedDelivery, 5000, "queued envelope");
  const received2 = envelopeFromJson(queuedJson);
  await verifyEnvelope(received2, await importPublicKey(aPub), Date.now());
  const key2 = await ratchetDecrypt(sessionB, {
    ratchetPublicKeyB64: received2.ratchetPublicKeyB64,
    messageNumber: received2.messageNumber,
    previousChainLength: received2.previousChainLength,
  });
  const opened2 = await decryptEnvelope(received2, key2);
  assert(
    new TextDecoder().decode(opened2) === JSON.stringify(message2),
    "queued payload should match",
  );
  console.log("[4/4] offline envelope queued and delivered on reconnect");

  await ta.disconnect();
  await tb2.disconnect();
  console.log("SMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
