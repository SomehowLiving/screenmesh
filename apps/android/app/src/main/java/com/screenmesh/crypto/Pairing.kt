package com.screenmesh.crypto

import com.screenmesh.protocol.PairingPayload
import com.screenmesh.protocol.LanPairingEndpoint
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
private const val SM1_PREFIX = "SM1"
private const val SM2_PREFIX = "SM2"
private val URL_SAFE_ID = Regex("^[A-Za-z0-9_-]{16,}$")

private fun validIpv4(address: String): Boolean {
    val octets = address.split(".")
    return octets.size == 4 && octets.all { it.matches(Regex("^(0|[1-9]\\d{0,2})$")) && it.toInt() <= 255 }
}

private fun validateLanEndpoint(endpoint: LanPairingEndpoint) {
    require(validIpv4(endpoint.address)) { "invalid local pairing endpoint" }
    require(endpoint.port in 1..65535) { "invalid local pairing endpoint" }
    require(URL_SAFE_ID.matches(endpoint.sessionId) && URL_SAFE_ID.matches(endpoint.sessionToken)) { "invalid local pairing endpoint" }
    require(endpoint.certificateSha256.startsWith("sha256/")) { "invalid local pairing certificate pin" }
    try {
        require(fromBase64(endpoint.certificateSha256.removePrefix("sha256/")).size == 32) { "invalid local pairing certificate pin" }
    } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException("invalid local pairing certificate pin")
    }
}

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

fun encodePairingPayload(payload: PairingPayload): String {
    val lan = payload.lanEndpoint
    if (lan != null) {
        validateLanEndpoint(lan)
        return listOf(
            SM2_PREFIX,
            payload.workspaceId,
            payload.pairingToken,
            base64ToUrlSafe(payload.workspaceKey),
            payload.expiresAt.toString(36),
            lan.address.replace(".", "-"),
            lan.port.toString(36),
            base64ToUrlSafe(lan.certificateSha256.removePrefix("sha256/")),
            lan.sessionId,
            lan.sessionToken,
        ).joinToString(".")
    }
    return listOf(
        SM1_PREFIX,
        payload.workspaceId,
        payload.pairingToken,
        base64ToUrlSafe(payload.workspaceKey),
        payload.expiresAt.toString(36),
    ).joinToString(".")
}

fun decodePairingPayload(encoded: String): PairingPayload {
    val parts = encoded.trim().split(".")
    if (parts.firstOrNull() == SM1_PREFIX && parts.size == 5) {
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
    if (parts.firstOrNull() != SM2_PREFIX || parts.size != 10) throw IllegalArgumentException("invalid pairing code")
    val workspaceId = parts[1]
    val pairingToken = parts[2]
    val keyUrlSafe = parts[3]
    val expiresAt36 = parts[4]
    val addressDashed = parts[5]
    val port36 = parts[6]
    val pinUrlSafe = parts[7]
    val sessionId = parts[8]
    val sessionToken = parts[9]
    if (workspaceId.isEmpty() || pairingToken.isEmpty() || keyUrlSafe.isEmpty() || expiresAt36.isEmpty() || addressDashed.isEmpty() || port36.isEmpty() || pinUrlSafe.isEmpty() || sessionId.isEmpty() || sessionToken.isEmpty()) {
        throw IllegalArgumentException("invalid pairing code")
    }
    val lan = LanPairingEndpoint(
        address = addressDashed.replace("-", "."),
        port = port36.toIntOrNull(36) ?: throw IllegalArgumentException("invalid pairing code"),
        certificateSha256 = "sha256/${base64FromUrlSafe(pinUrlSafe)}",
        sessionId = sessionId,
        sessionToken = sessionToken,
    )
    validateLanEndpoint(lan)
    return PairingPayload(
        workspaceId = workspaceId,
        pairingToken = pairingToken,
        workspaceKey = base64FromUrlSafe(keyUrlSafe),
        expiresAt = expiresAt36.toLong(36),
        lanEndpoint = lan,
    )
}

fun isPairingExpired(payload: PairingPayload, now: Long): Boolean = now >= payload.expiresAt
