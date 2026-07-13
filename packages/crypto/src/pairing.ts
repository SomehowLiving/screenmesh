import type { DeviceInfo, PairingPayload } from "@screenmesh/protocol";

/**
 * QR pairing: the trust ceremony between two devices. The QR (or join
 * link) encodes the workspace, its key, a single-use ephemeral token,
 * and the creator's identity. See docs/Security.md §2.
 */

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

export function createPairingPayload(params: {
  workspaceId: string;
  workspaceName: string;
  workspaceKey: string;
  serverUrl: string;
  creator: DeviceInfo;
  now: number;
  ttlMs?: number;
}): PairingPayload {
  const { now, ttlMs = DEFAULT_PAIRING_TTL_MS, ...rest } = params;
  return {
    ...rest,
    pairingToken: crypto.randomUUID(),
    expiresAt: now + ttlMs,
  };
}

export function encodePairingPayload(payload: PairingPayload): string {
  return btoa(JSON.stringify(payload));
}

export function decodePairingPayload(encoded: string): PairingPayload {
  const payload = JSON.parse(atob(encoded)) as PairingPayload;
  if (!payload.workspaceId || !payload.pairingToken || !payload.serverUrl) {
    throw new Error("invalid pairing payload");
  }
  return payload;
}

export function isPairingExpired(payload: PairingPayload, now: number): boolean {
  return now >= payload.expiresAt;
}
