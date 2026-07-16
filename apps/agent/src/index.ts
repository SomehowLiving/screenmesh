/**
 * ScreenMesh desktop agent: a trusted local process that can execute
 * approved commands and agent tasks (docs/Roadmap.md Phase 5). This is
 * the one Phase 5 item that genuinely can't be browser code — a page
 * can't spawn a shell — so it's a separate CLI reusing the exact same
 * crypto/sync/transport packages as the PWA. Same encryption, same
 * per-pair ratchet, same store-carry-forward; the only thing that
 * changes is what happens when a "command" or "agent_task" object
 * arrives: this device can actually run it, always behind an explicit
 * approval prompt (see docs/Security.md §8 — never automatic).
 *
 * Usage:
 *   screenmesh-agent --join "<join-link-or-code>" [--server <url>] [--name "My Desktop"]
 *   screenmesh-agent                                # resume a saved session
 */
import "fake-indexeddb/auto";
import readline from "node:readline/promises";
import { deserializeIdentity, importWorkspaceKey, sign } from "@screenmesh/crypto";
import { ScreenMeshDb } from "@screenmesh/storage";
import { MeshEngine } from "@screenmesh/sync";
import { WebSocketRelayTransport } from "@screenmesh/transport";
import type { SetCapabilitiesRequest } from "@screenmesh/protocol";
import { loadState, saveState } from "./state.js";
import { joinWorkspace, postJson } from "./join.js";
import { handleIncomingObject } from "./handleObject.js";

const STATE_PATH =
  process.env.SCREENMESH_AGENT_STATE ??
  `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.screenmesh-agent.json`;

function parseArgs(argv: string[]): { join?: string; name: string; server?: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--")) {
      args[argv[i]!.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return {
    ...(args.join ? { join: args.join } : {}),
    name: args.name || "Desktop Agent",
    ...(args.server ? { server: args.server } : {}),
  };
}

async function main(): Promise<void> {
  const { join, name, server } = parseArgs(process.argv.slice(2));

  let state = join ? await joinWorkspace(join, name, server) : await loadState(STATE_PATH);
  if (join && state) {
    await saveState(STATE_PATH, state);
    console.log(`Joined workspace ${state.workspaceId} as "${name}" (${state.identity.deviceId}).`);
  }
  if (!state) {
    console.error(
      'No saved session found. Pair first:\n  screenmesh-agent --join "<join-link-or-code>" [--server <url>] [--name "My Desktop"]\n\n' +
        "The join link is in the web app's pairing panel (\"Copy join link\").",
    );
    process.exitCode = 1;
    return;
  }

  const identity = await deserializeIdentity(state.identity);
  const workspaceKey = await importWorkspaceKey(state.workspaceKeyB64);
  const db = new ScreenMeshDb(`screenmesh-agent-${state.workspaceId}`);
  const transport = new WebSocketRelayTransport(`${state.serverUrl.replace(/^http/, "ws")}/relay`, {
    deviceId: identity.deviceId,
    workspaceId: state.workspaceId,
    sign: (data) => sign(identity, data),
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const engine = new MeshEngine({
    db,
    identity,
    workspaceId: state.workspaceId,
    workspaceKey,
    ownerDeviceId: state.ownerDeviceId,
    transport,
    onObjectReceived: (object, senderId) => {
      const approve = async (description: string) => {
        const answer = await rl.question(`\n${description}\n[R]un it, anything else rejects: `);
        return answer.trim().toLowerCase().startsWith("r");
      };
      void handleIncomingObject(engine, approve, object, senderId, (line) =>
        console.log(`${line}\n`),
      ).catch((err) => {
        console.error("screenmesh-agent: failed handling incoming object", err);
      });
    },
  });

  await engine.start();

  // Re-advertise on every run — the MVP registry (apps/server) is
  // in-memory, so a server restart forgets what we advertised last time.
  await postJson(`${state.serverUrl}/workspaces/${state.workspaceId}/capabilities`, {
    deviceId: identity.deviceId,
    capabilities: ["terminal"],
  } satisfies SetCapabilitiesRequest).catch(() => {
    /* best-effort; presence will still work without it */
  });

  console.log(
    `screenmesh-agent listening as "${state.deviceName}" (capability: terminal). ` +
      "Commands and agent tasks always ask before running anything. Ctrl+C to stop.",
  );

  process.on("SIGINT", () => {
    void engine.stop().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
