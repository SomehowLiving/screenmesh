package com.screenmesh.protocol

import kotlinx.serialization.Serializable
import com.screenmesh.crypto.fromBase64
import com.screenmesh.crypto.toBase64

/**
 * Kotlin mirror of packages/protocol/src/envelope.ts. The payload key
 * comes from a per-pair Double Ratchet session, not a shared workspace
 * secret — ratchetPublicKeyB64/messageNumber/previousChainLength are
 * exactly what the recipient needs to derive the matching message key
 * (see com.screenmesh.crypto.Ratchet). See docs/Security.md §3, §5.
 */
data class SecureEnvelope(
    val version: Int,
    val messageId: String,
    val senderDeviceId: String,
    val recipientDeviceId: String,
    val workspaceId: String,
    val createdAt: Long,
    val expiresAt: Long? = null,
    /** Monotonic per-sender counter; secondary to messageId dedup for replay protection. */
    val sequenceNumber: Int,
    /** Sender's current ratchet public key (base64 X25519). */
    val ratchetPublicKeyB64: String,
    /** Position in the sending chain identified by ratchetPublicKeyB64. */
    val messageNumber: Int,
    /** Length of the sender's previous sending chain. */
    val previousChainLength: Int,
    /** AES-GCM nonce (12 bytes) prepended to the ciphertext. */
    val ciphertext: ByteArray,
    /** Ed25519 signature over the envelope fields + ciphertext. */
    val signature: ByteArray,
)

const val ENVELOPE_VERSION = 2

/** JSON wire form of a SecureEnvelope (binary fields as base64) — must match EnvelopeJson in envelope.ts field-for-field. */
@Serializable
data class EnvelopeJson(
    val version: Int,
    val messageId: String,
    val senderDeviceId: String,
    val recipientDeviceId: String,
    val workspaceId: String,
    val createdAt: Long,
    val expiresAt: Long? = null,
    val sequenceNumber: Int,
    val ratchetPublicKeyB64: String,
    val messageNumber: Int,
    val previousChainLength: Int,
    val ciphertext: String,
    val signature: String,
)

fun SecureEnvelope.toJson(): EnvelopeJson = EnvelopeJson(
    version = version,
    messageId = messageId,
    senderDeviceId = senderDeviceId,
    recipientDeviceId = recipientDeviceId,
    workspaceId = workspaceId,
    createdAt = createdAt,
    expiresAt = expiresAt,
    sequenceNumber = sequenceNumber,
    ratchetPublicKeyB64 = ratchetPublicKeyB64,
    messageNumber = messageNumber,
    previousChainLength = previousChainLength,
    ciphertext = toBase64(ciphertext),
    signature = toBase64(signature),
)

fun EnvelopeJson.toEnvelope(): SecureEnvelope = SecureEnvelope(
    version = version,
    messageId = messageId,
    senderDeviceId = senderDeviceId,
    recipientDeviceId = recipientDeviceId,
    workspaceId = workspaceId,
    createdAt = createdAt,
    expiresAt = expiresAt,
    sequenceNumber = sequenceNumber,
    ratchetPublicKeyB64 = ratchetPublicKeyB64,
    messageNumber = messageNumber,
    previousChainLength = previousChainLength,
    ciphertext = fromBase64(ciphertext),
    signature = fromBase64(signature),
)

/**
 * Payload encoded into a pairing QR code / join link (PairingPayload in
 * envelope.ts). `workspaceKey` is the base64 raw secret that seeds every
 * pairwise ratchet session in this workspace — see docs/Security.md §5.
 */
data class PairingPayload(
    val workspaceId: String,
    val workspaceKey: String,
    val pairingToken: String,
    val expiresAt: Long,
    val serverUrl: String? = null,
)
