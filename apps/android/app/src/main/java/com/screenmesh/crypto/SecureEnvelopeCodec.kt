package com.screenmesh.crypto

import com.screenmesh.protocol.ENVELOPE_VERSION
import com.screenmesh.protocol.SecureEnvelope
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.nio.charset.StandardCharsets
import java.util.UUID
import javax.crypto.SecretKey

/**
 * Kotlin mirror of packages/crypto/src/envelope.ts: seal/open
 * SecureEnvelopes. AES-GCM encrypt with a per-message ratchet key (nonce
 * prepended to the ciphertext), then Ed25519-sign the canonical envelope
 * bytes — including the ratchet header, so a MITM can't swap in a
 * different ratchet position without invalidating the signature. See
 * docs/Security.md §3 and §5.
 *
 * verifyEnvelope and decryptEnvelope are deliberately SEPARATE calls (not
 * one "openEnvelope"): the ratchet header must never be trusted enough to
 * advance session state before the signature is checked — a forged
 * envelope with a manipulated ratchetPublicKeyB64/messageNumber could
 * otherwise corrupt the session before its authenticity is known. Callers
 * must always verify, THEN derive the ratchet message key from the
 * (now-trusted) header, THEN decrypt.
 */

/** Field order and "|" join must match canonicalBytes in envelope.ts exactly — this is signed, cross-language wire data. */
private fun canonicalBytes(env: SecureEnvelope): ByteArray {
    val head = listOf(
        env.version.toString(),
        env.messageId,
        env.senderDeviceId,
        env.recipientDeviceId,
        env.workspaceId,
        env.createdAt.toString(),
        env.expiresAt?.toString() ?: "",
        env.sequenceNumber.toString(),
        env.ratchetPublicKeyB64,
        env.messageNumber.toString(),
        env.previousChainLength.toString(),
    ).joinToString("|")
    return "$head|${toBase64(env.ciphertext)}".toByteArray(StandardCharsets.UTF_8)
}

data class SealParams(
    val identity: DeviceIdentity,
    val recipientDeviceId: String,
    val workspaceId: String,
    /** Per-message AES-GCM key derived from the sender's ratchet session. */
    val messageKey: SecretKey,
    val ratchetHeader: RatchetMessageHeader,
    val plaintext: ByteArray,
    val sequenceNumber: Int,
    val createdAt: Long,
    val expiresAt: Long? = null,
)

fun sealEnvelope(params: SealParams): SecureEnvelope {
    val (nonce, ciphertext) = encrypt(params.messageKey, params.plaintext)
    val combined = ByteArray(nonce.size + ciphertext.size)
    System.arraycopy(nonce, 0, combined, 0, nonce.size)
    System.arraycopy(ciphertext, 0, combined, nonce.size, ciphertext.size)

    val unsigned = SecureEnvelope(
        version = ENVELOPE_VERSION,
        messageId = UUID.randomUUID().toString(),
        senderDeviceId = params.identity.deviceId,
        recipientDeviceId = params.recipientDeviceId,
        workspaceId = params.workspaceId,
        createdAt = params.createdAt,
        expiresAt = params.expiresAt,
        sequenceNumber = params.sequenceNumber,
        ratchetPublicKeyB64 = params.ratchetHeader.ratchetPublicKeyB64,
        messageNumber = params.ratchetHeader.messageNumber,
        previousChainLength = params.ratchetHeader.previousChainLength,
        ciphertext = combined,
        signature = ByteArray(0),
    )
    val signature = sign(params.identity, canonicalBytes(unsigned))
    return unsigned.copy(signature = signature)
}

/**
 * Step 1: check expiry and authenticity. MUST be called — and must
 * succeed — before the envelope's ratchet header is used for anything,
 * including deriving a message key (which mutates ratchet session state).
 */
fun verifyEnvelope(env: SecureEnvelope, senderPublicKey: Ed25519PublicKeyParameters, now: Long) {
    if (env.expiresAt != null && now >= env.expiresAt) {
        throw Exception("envelope ${env.messageId} expired")
    }
    val ok = verify(senderPublicKey, env.signature, canonicalBytes(env))
    if (!ok) {
        throw Exception("invalid signature on envelope ${env.messageId}")
    }
}

/**
 * Step 2: decrypt. Only call after verifyEnvelope has succeeded AND the
 * ratchet session has derived `messageKey` from this envelope's
 * (now-trusted) header.
 */
fun decryptEnvelope(env: SecureEnvelope, messageKey: SecretKey): ByteArray {
    val nonce = env.ciphertext.copyOfRange(0, NONCE_BYTES)
    val ciphertext = env.ciphertext.copyOfRange(NONCE_BYTES, env.ciphertext.size)
    return decrypt(messageKey, EncryptedPayload(nonce, ciphertext))
}
