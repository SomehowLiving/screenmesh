import type {
  CreateWorkspaceRequest,
  DeviceInfo,
  DeviceType,
  JoinWorkspaceRequest,
  JoinWorkspaceResponse,
  PairingPayload,
  RotatePairingRequest,
} from "@screenmesh/protocol";
import {
  createPairingPayload,
  decodePairingPayload,
  encodePairingPayload,
  exportPublicKey,
  exportWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  importWorkspaceKey,
  sign,
} from "@screenmesh/crypto";
import type { ScreenMeshDb } from "@screenmesh/storage";
import { MeshEngine } from "@screenmesh/sync";
import { WebSocketRelayTransport } from "@screenmesh/transport";

export interface LocalIdentity {
  deviceId: string;
  name: string;
  deviceType: DeviceType;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
}

export interface LocalWorkspace {
  id: string;
  name: string;
  expiresAt?: number;
  serverUrl: string;
  ownerDeviceId: string;
}

export interface Session {
  engine: MeshEngine;
  transport: WebSocketRelayTransport;
}

export function serverBaseUrl(): string {
  return `${location.protocol}//${location.hostname}:8787`;
}

function relayWsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/relay`;
}

export function defaultDeviceType(): DeviceType {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "laptop";
}

function deviceInfo(me: LocalIdentity): DeviceInfo {
  return { id: me.deviceId, name: me.name, publicKey: me.publicKeyB64, type: me.deviceType };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep status code */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// --- local state ---

export async function loadLocal(db: ScreenMeshDb): Promise<{
  identity: LocalIdentity | null;
  workspace: LocalWorkspace | null;
  key: CryptoKey | null;
}> {
  const [identity, workspace, key] = await Promise.all([
    db.settings.get("identity"),
    db.settings.get("workspace"),
    db.settings.get("workspaceKey"),
  ]);
  return {
    identity: (identity?.value as LocalIdentity | undefined) ?? null,
    workspace: (workspace?.value as LocalWorkspace | undefined) ?? null,
    key: (key?.value as CryptoKey | undefined) ?? null,
  };
}

export async function createLocalIdentity(
  db: ScreenMeshDb,
  name: string,
  deviceType: DeviceType,
): Promise<LocalIdentity> {
  const generated = await generateIdentity();
  const identity: LocalIdentity = {
    deviceId: generated.deviceId,
    name,
    deviceType,
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    publicKeyB64: await exportPublicKey(generated.publicKey),
  };
  await db.settings.put({ key: "identity", value: identity });
  return identity;
}

// --- workspace lifecycle ---

export async function createWorkspaceOnServer(
  db: ScreenMeshDb,
  me: LocalIdentity,
  name: string,
): Promise<{ workspace: LocalWorkspace; key: CryptoKey; pairing: PairingPayload }> {
  const key = await generateWorkspaceKey();
  const serverUrl = serverBaseUrl();
  const workspaceId = crypto.randomUUID();
  const now = Date.now();
  const pairing = createPairingPayload({
    workspaceId,
    workspaceName: name,
    workspaceKey: await exportWorkspaceKey(key),
    serverUrl,
    creator: deviceInfo(me),
    now,
  });
  const body: CreateWorkspaceRequest = {
    workspace: { id: workspaceId, name, createdAt: now },
    device: deviceInfo(me),
    pairingToken: pairing.pairingToken,
    tokenExpiresAt: pairing.expiresAt,
  };
  await postJson(`${serverUrl}/workspaces`, body);

  const workspace: LocalWorkspace = {
    id: workspaceId,
    name,
    serverUrl,
    ownerDeviceId: me.deviceId,
  };
  await db.settings.bulkPut([
    { key: "workspace", value: workspace },
    { key: "workspaceKey", value: key },
  ]);
  return { workspace, key, pairing };
}

export async function joinWorkspaceFromPayload(
  db: ScreenMeshDb,
  me: LocalIdentity,
  payload: PairingPayload,
): Promise<{ workspace: LocalWorkspace; key: CryptoKey }> {
  const body: JoinWorkspaceRequest = {
    pairingToken: payload.pairingToken,
    device: deviceInfo(me),
  };
  const data = await postJson<JoinWorkspaceResponse>(
    `${payload.serverUrl}/workspaces/${payload.workspaceId}/join`,
    body,
  );
  const key = await importWorkspaceKey(payload.workspaceKey);
  const workspace: LocalWorkspace = {
    id: data.workspace.id,
    name: data.workspace.name,
    serverUrl: payload.serverUrl,
    ownerDeviceId: data.workspace.ownerDeviceId,
    ...(data.workspace.expiresAt !== undefined
      ? { expiresAt: data.workspace.expiresAt }
      : {}),
  };
  await db.settings.bulkPut([
    { key: "workspace", value: workspace },
    { key: "workspaceKey", value: key },
  ]);
  await db.devices.bulkPut(
    data.devices.map((entry) => ({
      id: entry.id,
      name: entry.name,
      publicKey: entry.publicKey,
      type: entry.type,
      role: entry.type === "phone" ? ("input" as const) : ("editor" as const),
      lastSeenAt: entry.lastSeenAt,
      status: entry.online ? ("online" as const) : ("offline" as const),
      trusted: true,
    })),
  );
  return { workspace, key };
}

/** Owner-only: mint a fresh single-use pairing token and QR payload. */
export async function rotatePairing(
  me: LocalIdentity,
  workspace: LocalWorkspace,
  workspaceKey: CryptoKey,
): Promise<PairingPayload> {
  const pairing = createPairingPayload({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceKey: await exportWorkspaceKey(workspaceKey),
    serverUrl: workspace.serverUrl,
    creator: deviceInfo(me),
    now: Date.now(),
  });
  const body: RotatePairingRequest = {
    deviceId: me.deviceId,
    pairingToken: pairing.pairingToken,
    tokenExpiresAt: pairing.expiresAt,
  };
  await postJson(`${workspace.serverUrl}/workspaces/${workspace.id}/pairing-token`, body);
  return pairing;
}

export function makeJoinUrl(payload: PairingPayload): string {
  const encoded = encodeURIComponent(encodePairingPayload(payload));
  return `${location.origin}${location.pathname}${location.search}#join=${encoded}`;
}

/** Accepts a full join URL or a raw pairing code. */
export function parseJoinInput(input: string): PairingPayload {
  let code = input.trim();
  const marker = code.indexOf("#join=");
  if (marker >= 0) code = code.slice(marker + 6);
  try {
    code = decodeURIComponent(code);
  } catch {
    /* already decoded */
  }
  return decodePairingPayload(code);
}

// --- engine ---

export function buildEngine(
  db: ScreenMeshDb,
  me: LocalIdentity,
  workspace: LocalWorkspace,
  workspaceKey: CryptoKey,
): Session {
  const identity = {
    deviceId: me.deviceId,
    publicKey: me.publicKey,
    privateKey: me.privateKey,
  };
  const transport = new WebSocketRelayTransport(relayWsUrl(workspace.serverUrl), {
    deviceId: me.deviceId,
    workspaceId: workspace.id,
    sign: (data) => sign(identity, data),
  });
  const engine = new MeshEngine({
    db,
    identity,
    workspaceId: workspace.id,
    workspaceKey,
    transport,
  });
  return { engine, transport };
}
