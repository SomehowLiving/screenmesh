import {
  fromBase64,
  pairingRotationAuthorizationBytes,
  type RotatePairingRequest,
} from "@screenmesh/protocol";
import { importPublicKey, verify } from "@screenmesh/crypto";

/** A captured signed request is deliberately useless after this short window. */
export const PAIRING_ROTATION_AUTH_MAX_AGE_MS = 60_000;
const MAX_FUTURE_SKEW_MS = 15_000;
const URL_SAFE_ID = /^[A-Za-z0-9_-]{16,}$/;

export async function verifyPairingRotationAuthorization(params: {
  workspaceId: string;
  ownerPublicKey: string;
  request: RotatePairingRequest;
  now?: number;
}): Promise<boolean> {
  const now = params.now ?? Date.now();
  const { request } = params;
  if (
    !Number.isSafeInteger(request.issuedAt) ||
    now - request.issuedAt > PAIRING_ROTATION_AUTH_MAX_AGE_MS ||
    request.issuedAt - now > MAX_FUTURE_SKEW_MS ||
    !URL_SAFE_ID.test(request.nonce) ||
    !URL_SAFE_ID.test(request.pairingToken)
  ) {
    return false;
  }
  try {
    const key = await importPublicKey(params.ownerPublicKey);
    return await verify(
      key,
      fromBase64(request.signature),
      pairingRotationAuthorizationBytes(params.workspaceId, request),
    );
  } catch {
    return false;
  }
}
