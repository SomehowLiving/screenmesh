import {
  decodePairingPayload,
  exportEncryptionPublicKey,
  exportPublicKey,
  generateIdentity,
  serializeIdentity,
} from "@screenmesh/crypto";
import type { DeviceInfo, JoinWorkspaceRequest, JoinWorkspaceResponse } from "@screenmesh/protocol";
import type { AgentState } from "./state.js";

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Accepts a full "copy join link" (https://host/#join=CODE) or a raw code + explicit server. */
export function parseJoinArg(
  input: string,
  explicitServer?: string,
): { code: string; serverUrl: string } {
  const marker = input.indexOf("#join=");
  if (marker >= 0) {
    const origin = input.slice(0, input.indexOf("/#join="));
    return { code: decodeURIComponent(input.slice(marker + 6)), serverUrl: `${origin}/api` };
  }
  if (!explicitServer) {
    throw new Error(
      "a raw pairing code needs an explicit server URL — or paste the full join link (with #join=...) instead",
    );
  }
  return { code: input, serverUrl: explicitServer };
}

export async function joinWorkspace(
  joinArg: string,
  name: string,
  server?: string,
): Promise<AgentState> {
  const { code, serverUrl } = parseJoinArg(joinArg, server);
  const payload = decodePairingPayload(code);
  const effectiveServerUrl = payload.serverUrl ?? serverUrl;

  // Extractable keys: unlike the browser (which relies on IndexedDB's
  // native CryptoKey persistence), this process persists identity to a
  // plain JSON file and needs to export/re-import the private keys.
  const identity = await generateIdentity({ extractable: true });
  const device: DeviceInfo = {
    id: identity.deviceId,
    name,
    publicKey: await exportPublicKey(identity.publicKey),
    encryptionKey: await exportEncryptionPublicKey(identity.encryptionPublicKey),
    type: "desktop",
    capabilities: ["terminal"],
  };
  const joined = await postJson<JoinWorkspaceResponse>(
    `${effectiveServerUrl}/workspaces/${payload.workspaceId}/join`,
    { pairingToken: payload.pairingToken, device } satisfies JoinWorkspaceRequest,
  );

  return {
    identity: await serializeIdentity(identity),
    deviceName: name,
    workspaceId: joined.workspace.id,
    ownerDeviceId: joined.workspace.ownerDeviceId,
    serverUrl: effectiveServerUrl,
    workspaceKeyB64: payload.workspaceKey,
  };
}
