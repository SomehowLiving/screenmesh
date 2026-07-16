/**
 * End-to-end smoke test for the desktop agent, against a running relay
 * server: a "sender" device creates a workspace, the agent JOINS it via
 * the real join.ts logic (same code path the CLI uses), then exchanges
 * command/agent_task objects and verifies approval-gated execution and
 * results — with an automated (non-interactive) approval function
 * standing in for the CLI's readline prompt.
 *
 * Run: pnpm --filter @screenmesh/agent exec tsx scripts/agent-smoke.ts
 */
import "fake-indexeddb/auto";
import {
  createPairingPayload,
  encodePairingPayload,
  deserializeIdentity,
  exportEncryptionPublicKey,
  exportPublicKey,
  exportWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  importWorkspaceKey,
  sign,
} from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { MeshEngine } from "@screenmesh/sync";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import type { CreateWorkspaceRequest, TextContent } from "@screenmesh/protocol";
import { joinWorkspace } from "../src/join.js";
import { handleIncomingObject } from "../src/handleObject.js";

const SERVER = "http://127.0.0.1:8787/api";
const RELAY = "ws://127.0.0.1:8787/api/relay";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

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

async function main(): Promise<void> {
  // 1. Sender device A creates a workspace and a pairing code, exactly
  //    like the web app would.
  const a = await generateIdentity();
  const workspaceId = crypto.randomUUID();
  const pairingToken = crypto.randomUUID();
  const workspaceKey = await generateWorkspaceKey();

  await post(`${SERVER}/workspaces`, {
    workspace: { id: workspaceId, name: "agent-smoke", createdAt: Date.now() },
    device: {
      id: a.deviceId,
      name: "Sender",
      publicKey: await exportPublicKey(a.publicKey),
      encryptionKey: await exportEncryptionPublicKey(a.encryptionPublicKey),
      type: "laptop",
    },
    pairingToken,
    tokenExpiresAt: Date.now() + 60_000,
  } satisfies CreateWorkspaceRequest);

  const pairing = createPairingPayload({
    workspaceId,
    workspaceKey: await exportWorkspaceKey(workspaceKey),
    serverUrl: SERVER,
    now: Date.now(),
  });
  // pairingToken above is what /workspaces registered; createPairingPayload
  // mints its own — override so the join actually redeems the real one.
  // The origin here doubles as the server origin (join.ts derives
  // serverUrl from it, same as a real join link from the web app would).
  const joinLink = `http://127.0.0.1:8787/#join=${encodePairingPayload({ ...pairing, pairingToken })}`;
  console.log("[1/5] sender created a workspace and a join link");

  // 2. The agent joins via the REAL join.ts logic (same path the CLI uses).
  const agentState = await joinWorkspace(joinLink, "Test Agent", SERVER);
  assert(agentState.workspaceId === workspaceId, "agent should join the same workspace");
  console.log("[2/5] desktop agent joined via join.ts (same code path as the CLI)");

  // 3. Bring both engines online.
  const aTransport = new WebSocketRelayTransport(RELAY, {
    deviceId: a.deviceId,
    workspaceId,
    sign: (data) => sign(a, data),
  });
  const aDb = new ScreenMeshDb("agent-smoke-sender");
  const aEngine = new MeshEngine({
    db: aDb,
    identity: a,
    workspaceId,
    workspaceKey,
    ownerDeviceId: a.deviceId,
    transport: aTransport,
    sweepIntervalMs: 500,
  });

  const agentIdentity = await deserializeIdentity(agentState.identity);
  const agentWorkspaceKey = await importWorkspaceKey(agentState.workspaceKeyB64);
  const agentDb = new ScreenMeshDb("agent-smoke-agent");
  const agentTransport = new WebSocketRelayTransport(RELAY, {
    deviceId: agentIdentity.deviceId,
    workspaceId: agentState.workspaceId,
    sign: (data) => sign(agentIdentity, data),
  });

  let approveNext = true; // toggled per-test below
  const agentEngine = new MeshEngine({
    db: agentDb,
    identity: agentIdentity,
    workspaceId: agentState.workspaceId,
    workspaceKey: agentWorkspaceKey,
    ownerDeviceId: agentState.ownerDeviceId,
    transport: agentTransport,
    sweepIntervalMs: 500,
    onObjectReceived: (object, senderId) => {
      void handleIncomingObject(
        agentEngine,
        async () => approveNext,
        object,
        senderId,
        (line) => console.log(`  [agent] ${line}`),
      ).catch((err) => console.error("agent handling failed", err));
    },
  });

  await aEngine.start();
  await agentEngine.start();
  await waitFor("sender sees the agent online", async () => {
    return (await aDb.devices.get(agentIdentity.deviceId))?.status === "online";
  });
  await waitFor("agent advertises the terminal capability", async () => {
    return !!(await aDb.devices.get(agentIdentity.deviceId))?.capabilities?.includes("terminal");
  });
  const resolved = await aEngine.resolveCapability("terminal");
  assert(resolved[0]?.id === agentIdentity.deviceId, "sender should resolve the agent via capability routing");
  console.log("[3/5] both engines online; sender resolves the agent via capability routing");

  // 4. Approved command: agent executes it and reports the result back.
  approveNext = true;
  const commandText = process.platform === "win32" ? "echo hello-from-agent" : "echo hello-from-agent";
  const cmdObject = await aEngine.sendObject({ type: "command", content: { text: commandText } }, [
    agentIdentity.deviceId,
  ]);
  await waitFor("sender receives the command result", async () => {
    const results = (await aDb.objects.toArray()).filter(
      (o) => o.createdBy === agentIdentity.deviceId,
    );
    return results.some((o) => (o.content as TextContent).text?.includes("hello-from-agent"));
  });
  await waitFor("sender's delivery for the command shows opened", async () => {
    const delivery = await aDb.deliveries.where("objectId").equals(cmdObject.id).first();
    return delivery?.status === "opened";
  });
  console.log("[4/5] approved command executed on the agent; output returned and command marked opened");

  // 5. Rejected agent_task: no handler runs, sender is told it was rejected.
  approveNext = false;
  const taskObject = await aEngine.sendObject(
    { type: "agent_task", content: { action: "run_command", params: { command: "echo should-not-run" } } },
    [agentIdentity.deviceId],
  );
  await waitFor("sender is told the task was rejected", async () => {
    const results = (await aDb.objects.toArray()).filter(
      (o) => o.createdBy === agentIdentity.deviceId,
    );
    return results.some((o) => (o.content as TextContent).text?.includes("was rejected"));
  });
  const leaked = (await aDb.objects.toArray()).filter((o) => o.createdBy === agentIdentity.deviceId);
  assert(
    !leaked.some((o) => (o.content as TextContent).text?.includes("should-not-run")),
    "a rejected task must never actually run",
  );
  void taskObject;
  console.log("[5/5] rejected agent_task did not execute; sender was told it was rejected");

  await aEngine.stop();
  await agentEngine.stop();
  console.log("AGENT SMOKE OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
