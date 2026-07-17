package com.screenmesh.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Canonical ScreenMesh data model — Kotlin mirror of
 * packages/protocol/src/types.ts. Field names and JSON shapes must match
 * exactly; this is the wire format shared with the web PWA and the
 * desktop agent. `type`/`role`/`capabilities` stay plain String (not
 * Kotlin enums) deliberately — the TS side treats DeviceCapability as an
 * open set ("not a closed enum"), and plain strings guarantee there's no
 * enum-serialization mapping to get subtly wrong.
 */

object DeviceTypes {
    const val PHONE = "phone"
    const val LAPTOP = "laptop"
    const val TABLET = "tablet"
    const val DISPLAY = "display"
    const val DESKTOP = "desktop"
}

object DeviceCapabilities {
    const val TERMINAL = "terminal"
    const val FILESYSTEM = "filesystem"
    const val CAMERA = "camera"
    const val MICROPHONE = "microphone"
    const val GPS = "gps"
    const val BROWSER = "browser"
    const val LOCAL_MODELS = "local-models"
}

object MeshObjectTypes {
    const val TEXT = "text"
    const val LINK = "link"
    const val CODE = "code"
    const val IMAGE = "image"
    const val FILE = "file"
    const val CHECKLIST = "checklist"
    const val CLIPBOARD = "clipboard"
    const val COMMAND = "command"
    const val AGENT_TASK = "agent_task"
}

object DeliveryStatuses {
    const val QUEUED = "queued"
    const val SENDING = "sending"
    const val DELIVERED = "delivered"
    const val PENDING = "pending"
    const val OPENED = "opened"
    const val REJECTED = "rejected"
    const val EXPIRED = "expired"
    const val FAILED = "failed"
}

/** The subset of Device exchanged during pairing and presence (DeviceInfo in types.ts). */
@Serializable
data class DeviceInfo(
    val id: String,
    val name: String,
    /** Base64 Ed25519 signing public key. */
    val publicKey: String,
    /** Base64 X25519 public key for key-agreement. */
    val encryptionKey: String? = null,
    val type: String,
    val capabilities: List<String>? = null,
)

/** Local roster entry — DeviceInfo plus presence/trust bookkeeping (Device in types.ts). */
data class Device(
    val id: String,
    val name: String,
    val publicKey: String,
    val encryptionKey: String?,
    val type: String,
    val role: String,
    val capabilities: List<String>?,
    val lastSeenAt: Long,
    val status: String, // "online" | "offline"
    val trusted: Boolean,
)

@Serializable
data class MeshObject(
    val id: String,
    val workspaceId: String,
    val type: String,
    val content: JsonElement,
    val createdBy: String,
    val createdAt: Long,
    val updatedAt: Long,
    val expiresAt: Long? = null,
)

data class Delivery(
    val id: String,
    val objectId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val status: String,
    val createdAt: Long,
    val deliveredAt: Long? = null,
    val openedAt: Long? = null,
    val options: SendOptions? = null,
)

@Serializable
data class TextContent(val text: String)

@Serializable
data class FileContent(
    val name: String,
    val mimeType: String,
    val size: Long,
    val dataB64: String,
)

@Serializable
data class ChecklistItem(val id: String, val text: String, val done: Boolean)

@Serializable
data class ChecklistContent(val items: List<ChecklistItem>)

@Serializable
data class AgentTaskContent(
    val action: String,
    val params: Map<String, JsonElement>? = null,
)

@Serializable
data class SendOptions(
    val deliverWhenDeviceReturns: Boolean? = null,
    val expiresAt: Long? = null,
    val deleteAfterOpening: Boolean? = null,
    val requireConfirmation: Boolean? = null,
) {
    val isEmpty: Boolean
        get() = deliverWhenDeviceReturns == null && expiresAt == null &&
            deleteAfterOpening == null && requireConfirmation == null
}
