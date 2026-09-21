import {
  base64FromUrlSafe,
  base64ToUrlSafe,
  fromBase64,
  toBase64,
  type LanPairingEndpoint,
  type PairingPayload,
} from "@screenmesh/protocol";

/**
 * QR pairing: the trust ceremony between two devices.
 *
 * The pairing code is a compact, URL-safe string — NOT base64 JSON — so
 * the QR stays low-density and scans easily from a screen:
 *
 *   SM1.<workspaceId>.<pairingToken>.<workspaceKey>.<expiresAt base36>
 *   SM2.<SM1 fields>.<IPv4-with-dashes>.<port base36>.<SPKI pin>.<sessionId>.<sessionToken>
 *
 * Only what the visual channel must carry is encoded; workspace name,
 * device roster, and owner identity come from the join response.
 * See docs/Security.md §2.
 */

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const SM1_PREFIX = "SM1";
const SM2_PREFIX = "SM2";
const URL_SAFE_ID = /^[A-Za-z0-9_-]{16,}$/;

function validIpv4(address: string): boolean {
  const octets = address.split(".");
  return octets.length === 4 && octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

function validateLanEndpoint(endpoint: LanPairingEndpoint): void {
  if (!validIpv4(endpoint.address) || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !URL_SAFE_ID.test(endpoint.sessionId) || !URL_SAFE_ID.test(endpoint.sessionToken)) {
    throw new Error("invalid local pairing endpoint");
  }
  if (!endpoint.certificateSha256.startsWith("sha256/")) throw new Error("invalid local pairing certificate pin");
  try {
    if (fromBase64(endpoint.certificateSha256.slice("sha256/".length)).length !== 32) throw new Error("invalid pin length");
  } catch {
    throw new Error("invalid local pairing certificate pin");
  }
}

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
  if (payload.lanEndpoint) {
    validateLanEndpoint(payload.lanEndpoint);
    return [
      SM2_PREFIX,
      payload.workspaceId,
      payload.pairingToken,
      base64ToUrlSafe(payload.workspaceKey),
      payload.expiresAt.toString(36),
      payload.lanEndpoint.address.replace(/\./g, "-"),
      payload.lanEndpoint.port.toString(36),
      base64ToUrlSafe(payload.lanEndpoint.certificateSha256.slice("sha256/".length)),
      payload.lanEndpoint.sessionId,
      payload.lanEndpoint.sessionToken,
    ].join(".");
  }
  return [
    SM1_PREFIX,
    payload.workspaceId,
    payload.pairingToken,
    base64ToUrlSafe(payload.workspaceKey),
    payload.expiresAt.toString(36),
  ].join(".");
}

export function decodePairingPayload(encoded: string): PairingPayload {
  const parts = encoded.trim().split(".");
  if (parts[0] === SM1_PREFIX && parts.length === 5) {
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
  if (parts[0] !== SM2_PREFIX || parts.length !== 10) {
    throw new Error("invalid pairing code");
  }
  const [, workspaceId, pairingToken, keyUrlSafe, expiresAt36, addressDashed, port36, pinUrlSafe, sessionId, sessionToken] = parts;
  if (!workspaceId || !pairingToken || !keyUrlSafe || !expiresAt36 || !addressDashed || !port36 || !pinUrlSafe || !sessionId || !sessionToken) {
    throw new Error("invalid pairing code");
  }
  const lanEndpoint: LanPairingEndpoint = {
    address: addressDashed.replace(/-/g, "."),
    port: parseInt(port36, 36),
    certificateSha256: `sha256/${base64FromUrlSafe(pinUrlSafe)}`,
    sessionId,
    sessionToken,
  };
  validateLanEndpoint(lanEndpoint);
  const expiresAt = parseInt(expiresAt36, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new Error("invalid pairing code");
  return {
    workspaceId,
    pairingToken,
    workspaceKey: base64FromUrlSafe(keyUrlSafe),
    expiresAt,
    lanEndpoint,
  };
}

export function isPairingExpired(payload: PairingPayload, now: number): boolean {
  return now >= payload.expiresAt;
}
