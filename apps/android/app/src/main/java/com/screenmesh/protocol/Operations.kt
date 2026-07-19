package com.screenmesh.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Kotlin mirror of packages/protocol/src/operations.ts. `payload` stays a
 * raw JsonElement (not a sealed/polymorphic type) — exactly like the TS
 * side, which types it `unknown` and casts per `op.type` at the call
 * site (`op.payload as SendToDevicePayload`). This keeps the wire format
 * identical without needing kotlinx.serialization's polymorphic
 * discriminator config to also match the TS shape exactly.
 */
object OperationTypes {
    const val CREATE_OBJECT = "CREATE_OBJECT"
    const val UPDATE_OBJECT = "UPDATE_OBJECT"
    const val DELETE_OBJECT = "DELETE_OBJECT"
    const val SEND_TO_DEVICE = "SEND_TO_DEVICE"
    const val MARK_DELIVERED = "MARK_DELIVERED"
    const val MARK_OPENED = "MARK_OPENED"
    const val PIN_OBJECT = "PIN_OBJECT"
    const val MOVE_OBJECT = "MOVE_OBJECT"
    const val ADD_ATTACHMENT = "ADD_ATTACHMENT"
    const val REVOKE_DEVICE = "REVOKE_DEVICE"
    const val YJS_UPDATE = "YJS_UPDATE"
    const val CONTINUE_ON_DEVICE = "CONTINUE_ON_DEVICE"
    const val CARRY_BUNDLE = "CARRY_BUNDLE"
    const val REJECT_OBJECT = "REJECT_OBJECT"
    const val FILE_CHUNK = "FILE_CHUNK"
}

@Serializable
data class Operation(
    val operationId: String,
    val deviceId: String,
    val workspaceId: String,
    val type: String,
    val objectId: String? = null,
    val timestamp: Long,
    val payload: JsonElement,
)

@Serializable
data class CreateObjectPayload(val `object`: MeshObject)

@Serializable
data class SendToDevicePayload(val objectId: String, val options: SendOptions? = null)

@Serializable
data class ObjectRefPayload(val objectId: String)

@Serializable
data class RevokeDevicePayload(val deviceId: String)

/** A Yjs document update — NOT yet applied by MeshEngine.kt (no Yjs-for-Kotlin port yet). */
@Serializable
data class YjsUpdatePayload(val objectId: String, val updateB64: String)

/** Last-write-wins content replacement (checklist toggles, etc.). */
@Serializable
data class UpdateObjectPayload(val objectId: String, val content: JsonElement, val updatedAt: Long)

/** Applied by MeshEngine.kt's continueOnDevice / CONTINUE_ON_DEVICE case. */
@Serializable
data class ContinueOnDevicePayload(val objectId: String)

/** Store–carry–forward hand-off — applied by MeshEngine.kt's CARRY_BUNDLE case. */
@Serializable
data class CarryBundlePayload(
    val bundleId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val encryptedPayloadB64: String,
    val createdAt: Long,
    val expiresAt: Long,
    val hopLimit: Int,
)

/** Secure file drop chunk — applied by MeshEngine.kt's sendFileChunks / FILE_CHUNK case. */
@Serializable
data class FileChunkMeta(
    val objectType: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val createdBy: String,
    val createdAt: Long,
    val expiresAt: Long? = null,
    val options: SendOptions? = null,
)

@Serializable
data class FileChunkPayload(
    val fileId: String,
    val chunkIndex: Int,
    val totalChunks: Int,
    val dataB64: String,
    val meta: FileChunkMeta? = null,
)
