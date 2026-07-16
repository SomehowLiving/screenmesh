import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SerializedIdentity } from "@screenmesh/crypto";

/**
 * Everything the agent needs to resume without re-pairing. Deliberately
 * NOT the full local database (objects, deliveries, ratchet sessions) —
 * those stay in the in-memory fake-indexeddb store and are lost on
 * restart, which is fine: a lost ratchet session just re-bootstraps from
 * the identity keys + pairing secret here, exactly as the ratchet design
 * intends (docs/Security.md §5). Losing the DEVICE IDENTITY would force
 * re-pairing, which is the one thing worth persisting to disk.
 */
export interface AgentState {
  identity: SerializedIdentity;
  deviceName: string;
  workspaceId: string;
  ownerDeviceId: string;
  serverUrl: string;
  /** Raw AES pairing secret, base64 — same format as PairingPayload.workspaceKey. */
  workspaceKeyB64: string;
}

export async function loadState(path: string): Promise<AgentState | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as AgentState;
  } catch {
    return null;
  }
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Contains private key material — best-effort restrictive permissions
  // (meaningful on POSIX; Windows ACLs aren't affected by the mode bits).
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}
