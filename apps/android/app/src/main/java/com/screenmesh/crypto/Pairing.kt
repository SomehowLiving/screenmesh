package com.screenmesh.crypto

import com.screenmesh.protocol.PairingPayload
import java.security.SecureRandom

/**
 * Kotlin mirror of packages/crypto/src/pairing.ts — QR pairing, the trust
 * ceremony between two devices.
 *
 * The pairing code is a compact, URL-safe string — NOT base64 JSON — so
 * the QR stays low-density and scans easily from a screen:
 *
 *   SM1.<workspaceId>.<pairingToken>.<workspaceKey>.<expiresAt base36>
 *
 * Only what the visual channel must carry is encoded; workspace name,
 * device roster, and owner identity come from the join response. See
 * docs/Security.md §2.
 */

private const val DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000L
private const val CODE_PREFIX = "SM1"

/** Short, URL-safe random identifier (default 16 bytes -> 22 chars). */
fun randomId(byteLength: Int = 16): String {
    val bytes = ByteArray(byteLength).also { SecureRandom().nextBytes(it) }
    return base64ToUrlSafe(toBase64(bytes))
}

fun createPairingPayload(
    workspaceId: String,
    workspaceKey: String,
    now: Long,
    serverUrl: String? = null,
    ttlMs: Long = DEFAULT_PAIRING_TTL_MS,
): PairingPayload = PairingPayload(
    workspaceId = workspaceId,
    workspaceKey = workspaceKey,
    pairingToken = randomId(),
    expiresAt = now + ttlMs,
    serverUrl = serverUrl,
)

fun encodePairingPayload(payload: PairingPayload): String = listOf(
    CODE_PREFIX,
    payload.workspaceId,
    payload.pairingToken,
    base64ToUrlSafe(payload.workspaceKey),
    payload.expiresAt.toString(36),
).joinToString(".")

fun decodePairingPayload(encoded: String): PairingPayload {
    val parts = encoded.trim().split(".")
    if (parts.size != 5 || parts[0] != CODE_PREFIX) {
        throw IllegalArgumentException("invalid pairing code")
    }
    val (_, workspaceId, pairingToken, keyUrlSafe, expiresAt36) = parts
    if (workspaceId.isEmpty() || pairingToken.isEmpty() || keyUrlSafe.isEmpty() || expiresAt36.isEmpty()) {
        throw IllegalArgumentException("invalid pairing code")
    }
    return PairingPayload(
        workspaceId = workspaceId,
        pairingToken = pairingToken,
        workspaceKey = base64FromUrlSafe(keyUrlSafe),
        expiresAt = expiresAt36.toLong(36),
    )
}

fun isPairingExpired(payload: PairingPayload, now: Long): Boolean = now >= payload.expiresAt
