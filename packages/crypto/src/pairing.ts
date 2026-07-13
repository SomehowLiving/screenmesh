import {
  base64FromUrlSafe,
  base64ToUrlSafe,
  toBase64,
  type PairingPayload,
} from "@screenmesh/protocol";

/**
 * QR pairing: the trust ceremony between two devices.
 *
 * The pairing code is a compact, URL-safe string — NOT base64 JSON — so
 * the QR stays low-density and scans easily from a screen:
 *
 *   SM1.<workspaceId>.<pairingToken>.<workspaceKey>.<expiresAt base36>
 *
 * Only what the visual channel must carry is encoded; workspace name,
 * device roster, and owner identity come from the join response.
 * See docs/Security.md §2.
 */

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const CODE_PREFIX = "SM1";

/** Short, URL-safe random identifier (default 16 bytes → 22 chars). */
export function randomId(byteLength = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64ToUrlSafe(toBase64(bytes));
}

export function createPairingPayload(params: {
  workspaceId: string;
  workspaceKey: string;
  serverUrl?: string;
  now: number;
  ttlMs?: number;
}): PairingPayload {
  const { now, ttlMs = DEFAULT_PAIRING_TTL_MS, ...rest } = params;
  return {
    ...rest,
    pairingToken: randomId(),
    expiresAt: now + ttlMs,
  };
}

export function encodePairingPayload(payload: PairingPayload): string {
  return [
    CODE_PREFIX,
    payload.workspaceId,
    payload.pairingToken,
    base64ToUrlSafe(payload.workspaceKey),
    payload.expiresAt.toString(36),
  ].join(".");
}

export function decodePairingPayload(encoded: string): PairingPayload {
  const parts = encoded.trim().split(".");
  if (parts.length !== 5 || parts[0] !== CODE_PREFIX) {
    throw new Error("invalid pairing code");
  }
  const [, workspaceId, pairingToken, keyUrlSafe, expiresAt36] = parts;
  if (!workspaceId || !pairingToken || !keyUrlSafe || !expiresAt36) {
    throw new Error("invalid pairing code");
  }
  return {
    workspaceId,
    pairingToken,
    workspaceKey: base64FromUrlSafe(keyUrlSafe),
    expiresAt: parseInt(expiresAt36, 36),
  };
}

export function isPairingExpired(payload: PairingPayload, now: number): boolean {
  return now >= payload.expiresAt;
}
