import type {
  CreateWorkspaceRequest,
  DeviceInfo,
  DeviceType,
  JoinWorkspaceRequest,
  JoinWorkspaceResponse,
  PairingPayload,
  RevokeDeviceRequest,
  RotatePairingRequest,
} from "@screenmesh/protocol";
import {
  createPairingPayload,
  decodePairingPayload,
  encodePairingPayload,
  exportEncryptionPublicKey,
  exportPublicKey,
  exportWorkspaceKey,
  generateIdentity,
  generateWorkspaceKey,
  importWorkspaceKey,
  randomId,
  sign,
} from "@screenmesh/crypto";
import type { ScreenMeshDb } from "@screenmesh/storage";
import { MeshEngine } from "@screenmesh/sync";
import { WebRtcDirect, WebSocketRelayTransport } from "@screenmesh/transport";

export interface LocalIdentity {
  deviceId: string;
  name: string;
  deviceType: DeviceType;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
  encryptionPublicKey: CryptoKey;
  encryptionPrivateKey: CryptoKey;
  encryptionKeyB64: string;
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

/**
 * The relay is proxied same-origin under /api (see vite.config.ts), so
 * every device simply talks to whatever host it loaded the page from.
 */
export function serverBaseUrl(): string {
  return `${location.origin}/api`;
}

function relayWsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/relay`;
}

/**
 * An origin OTHER devices on the network can reach. When the page is open
 * on localhost, join links/QRs would be useless to a phone — ask the
 * server for this machine's LAN address and use that instead.
 */
export async function shareableOrigin(): Promise<string> {
  const { protocol, hostname, port } = location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return location.origin;
  try {
    const res = await fetch(`${serverBaseUrl()}/info`);
    const data = (await res.json()) as { addresses: string[] };
    const lanIp = data.addresses[0];
    if (lanIp) return `${protocol}//${lanIp}${port ? `:${port}` : ""}`;
  } catch {
    /* fall back to the local origin */
  }
  return location.origin;
}

export function defaultDeviceType(): DeviceType {
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "laptop";
}

function deviceInfo(me: LocalIdentity): DeviceInfo {
  return {
    id: me.deviceId,
    name: me.name,
    publicKey: me.publicKeyB64,
    encryptionKey: me.encryptionKeyB64,
    type: me.deviceType,
  };
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
  let localIdentity = (identity?.value as LocalIdentity | undefined) ?? null;
  // Identities created before key-rotation support lack X25519 keys —
  // upgrade in place (the Ed25519 identity and deviceId are preserved).
  if (localIdentity && !localIdentity.encryptionPrivateKey) {
    const pair = (await crypto.subtle.generateKey("X25519", false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    localIdentity = {
      ...localIdentity,
      encryptionPublicKey: pair.publicKey,
      encryptionPrivateKey: pair.privateKey,
      encryptionKeyB64: await exportEncryptionPublicKey(pair.publicKey),
    };
    await db.settings.put({ key: "identity", value: localIdentity });
  }
  return {
    identity: localIdentity,
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
    encryptionPublicKey: generated.encryptionPublicKey,
    encryptionPrivateKey: generated.encryptionPrivateKey,
    encryptionKeyB64: await exportEncryptionPublicKey(generated.encryptionPublicKey),
  };
  await db.settings.put({ key: "identity", value: identity });
  return identity;
}

// --- workspace lifecycle ---

export async function createWorkspaceOnServer(
  db: ScreenMeshDb,
  me: LocalIdentity,
  name: string,
  workspaceTtlMs?: number,
): Promise<{ workspace: LocalWorkspace; key: CryptoKey; pairing: PairingPayload }> {
  const key = await generateWorkspaceKey();
  const serverUrl = serverBaseUrl();
  // Short URL-safe id (22 chars vs a 36-char UUID) keeps the QR sparse.
  const workspaceId = randomId();
  const now = Date.now();
  const expiresAt = workspaceTtlMs !== undefined ? now + workspaceTtlMs : undefined;
  const pairing = createPairingPayload({
    workspaceId,
    workspaceKey: await exportWorkspaceKey(key),
    // The payload travels to OTHER devices — point it at a reachable host.
    serverUrl: `${await shareableOrigin()}/api`,
    now,
  });
  const body: CreateWorkspaceRequest = {
    workspace: {
      id: workspaceId,
      name,
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
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
    ...(expiresAt !== undefined ? { expiresAt } : {}),
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
  // The QR code doesn't carry a server URL — the join link already brought
  // us to the right host, so our own origin (same-origin proxy) is correct.
  const server = payload.serverUrl ?? serverBaseUrl();
  const data = await postJson<JoinWorkspaceResponse>(
    `${server}/workspaces/${payload.workspaceId}/join`,
    body,
  );
  const key = await importWorkspaceKey(payload.workspaceKey);
  const workspace: LocalWorkspace = {
    id: data.workspace.id,
    name: data.workspace.name,
    // Locally we always talk to our own origin (same-origin /api proxy),
    // regardless of which host the payload advertised.
    serverUrl: serverBaseUrl(),
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
    workspaceKey: await exportWorkspaceKey(workspaceKey),
    serverUrl: `${await shareableOrigin()}/api`,
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

/**
 * Owner-side revocation: server enforcement first (the device can no
 * longer authenticate), then notify the remaining devices via the engine.
 */
export async function revokeDevice(
  me: LocalIdentity,
  workspace: LocalWorkspace,
  engine: MeshEngine,
  deviceId: string,
): Promise<void> {
  const body: RevokeDeviceRequest = { ownerDeviceId: me.deviceId, deviceId };
  await postJson(`${workspace.serverUrl}/workspaces/${workspace.id}/revoke`, body);
  await engine.revokeDevice(deviceId);
  // Rotate the workspace key so the revoked device (which still holds the
  // old key) cannot decrypt anything sent from now on.
  await engine.rotateWorkspaceKey();
}

/**
 * Clear all workspace-scoped state (used on leave, revocation, or
 * workspace expiry). The device identity is kept.
 */
export async function leaveWorkspace(db: ScreenMeshDb): Promise<void> {
  await db.settings.bulkDelete(["workspace", "workspaceKey", "mySeq"]);
  await Promise.all([
    db.devices.clear(),
    db.objects.clear(),
    db.operations.clear(),
    db.deliveries.clear(),
    db.outbox.clear(),
    db.carried.clear(),
    db.seen.clear(),
  ]);
}

export function makeJoinUrl(payload: PairingPayload): string {
  // The pairing code is URL-safe by construction — no percent-encoding,
  // which keeps the QR in the compact alphanumeric-ish density range.
  const origin = (payload.serverUrl ?? serverBaseUrl()).replace(/\/api$/, "");
  return `${origin}/#join=${encodePairingPayload(payload)}`;
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
    encryptionPublicKey: me.encryptionPublicKey,
    encryptionPrivateKey: me.encryptionPrivateKey,
  };
  const transport = new WebSocketRelayTransport(relayWsUrl(workspace.serverUrl), {
    deviceId: me.deviceId,
    workspaceId: workspace.id,
    sign: (data) => sign(identity, data),
  });
  // Direct WebRTC data channels when the browser supports them; envelopes
  // then bypass the relay whenever a peer connection is up.
  const direct = WebRtcDirect.available()
    ? new WebRtcDirect(transport, me.deviceId)
    : undefined;
  const engine = new MeshEngine({
    db,
    identity,
    workspaceId: workspace.id,
    workspaceKey,
    ownerDeviceId: workspace.ownerDeviceId,
    transport,
    ...(direct
      ? {
          direct: {
            trySend: (peerId: string, data: Uint8Array) => direct.trySend(peerId, data),
            onMessage: (handler: (data: Uint8Array) => void) => direct.onMessage(handler),
          },
        }
      : {}),
  });
  return { engine, transport };
}
