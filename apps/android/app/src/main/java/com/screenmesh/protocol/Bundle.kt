package com.screenmesh.protocol

/**
 * Kotlin mirror of packages/protocol/src/bundle.ts. Store-carry-forward:
 * when the destination is unreachable, the encrypted bundle waits in the
 * outbox. Any trusted device may carry it toward the destination without
 * being able to read it. See docs/Architecture.md §2.
 *
 * NOT yet applied by MeshEngine.kt in this pass — carried here so the
 * wire-format model is complete even before the carry logic is ported.
 */
data class DeliveryBundle(
    val bundleId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val workspaceId: String,
    val encryptedPayload: ByteArray,
    val createdAt: Long,
    val expiresAt: Long,
    /** Remaining device-to-device hops before the bundle is dropped. */
    val hopLimit: Int,
    val signature: ByteArray,
    /** Devices already offered this bundle as a carrier (avoids re-offering). */
    val offeredTo: List<String>? = null,
)

const val DEFAULT_HOP_LIMIT = 4
