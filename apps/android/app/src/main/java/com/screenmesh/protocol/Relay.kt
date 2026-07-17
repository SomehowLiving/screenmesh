package com.screenmesh.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Kotlin mirror of packages/protocol/src/relay.ts — the relay wire
 * protocol (client <-> server) and pairing HTTP API. The TS side models
 * client/server messages as discriminated unions on `type`; rather than
 * fight kotlinx.serialization's polymorphic-discriminator config to
 * match that exactly, these are sealed classes with hand-written
 * toJson()/fromJson(JsonObject) that read/write the same "type" field
 * directly. This keeps the JSON shape on the wire identical without
 * relying on a serializer configuration that's hard to eyeball-verify
 * against the TS output.
 */

@Serializable
data class PresenceEntry(
    val id: String,
    val name: String,
    val publicKey: String,
    val encryptionKey: String? = null,
    val type: String,
    val capabilities: List<String>? = null,
    val online: Boolean,
    val lastSeenAt: Long,
)

sealed class RelayClientMessage {
    data class Auth(val deviceId: String, val workspaceId: String, val signature: String) : RelayClientMessage()
    data class EnvelopeMsg(val envelope: EnvelopeJson) : RelayClientMessage()

    /**
     * Store-carry-forward: relay this envelope on behalf of its ORIGINAL
     * sender (a carrier, not the envelope's own senderDeviceId). Unlike
     * EnvelopeMsg, the relay does NOT require senderDeviceId to match the
     * authenticated connection — the destination's own signature check on
     * the inner envelope is what guarantees authenticity here, not the
     * relay. See docs/Security.md.
     */
    data class Forward(val envelope: EnvelopeJson) : RelayClientMessage()

    /** WebRTC signaling (offers/answers/ICE), forwarded verbatim. */
    data class Signal(val to: String, val data: JsonElement) : RelayClientMessage()

    object Ping : RelayClientMessage()
}

fun RelayClientMessage.toJson(): JsonObject = when (this) {
    is RelayClientMessage.Auth -> buildJsonObject {
        put("type", "auth")
        put("deviceId", deviceId)
        put("workspaceId", workspaceId)
        put("signature", signature)
    }
    is RelayClientMessage.EnvelopeMsg -> buildJsonObject {
        put("type", "envelope")
        put("envelope", Json.encodeToJsonElement(EnvelopeJson.serializer(), envelope))
    }
    is RelayClientMessage.Forward -> buildJsonObject {
        put("type", "forward")
        put("envelope", Json.encodeToJsonElement(EnvelopeJson.serializer(), envelope))
    }
    is RelayClientMessage.Signal -> buildJsonObject {
        put("type", "signal")
        put("to", to)
        put("data", data)
    }
    RelayClientMessage.Ping -> buildJsonObject { put("type", "ping") }
}

sealed class RelayServerMessage {
    data class Challenge(val nonce: String) : RelayServerMessage()
    data class AuthOk(val queued: Int) : RelayServerMessage()
    data class AuthError(val reason: String) : RelayServerMessage()
    data class EnvelopeMsg(val envelope: EnvelopeJson) : RelayServerMessage()
    data class Presence(val devices: List<PresenceEntry>) : RelayServerMessage()
    data class Signal(val from: String, val data: JsonElement) : RelayServerMessage()
    object Pong : RelayServerMessage()
    data class Error(val reason: String) : RelayServerMessage()
}

/** Returns null on an unrecognized `type` — callers should ignore unknown message types, not throw. */
fun parseRelayServerMessage(json: JsonObject): RelayServerMessage? {
    return when (json["type"]?.jsonPrimitive?.content) {
        "challenge" -> RelayServerMessage.Challenge(json.getValue("nonce").jsonPrimitive.content)
        "authOk" -> RelayServerMessage.AuthOk(json.getValue("queued").jsonPrimitive.content.toInt())
        "authError" -> RelayServerMessage.AuthError(json.getValue("reason").jsonPrimitive.content)
        "envelope" -> RelayServerMessage.EnvelopeMsg(
            Json.decodeFromJsonElement(EnvelopeJson.serializer(), json.getValue("envelope")),
        )
        "presence" -> RelayServerMessage.Presence(
            Json.decodeFromJsonElement(
                kotlinx.serialization.builtins.ListSerializer(PresenceEntry.serializer()),
                json.getValue("devices"),
            ),
        )
        "signal" -> RelayServerMessage.Signal(
            json.getValue("from").jsonPrimitive.content,
            json["data"] ?: JsonNull,
        )
        "pong" -> RelayServerMessage.Pong
        "error" -> RelayServerMessage.Error(json.getValue("reason").jsonPrimitive.content)
        else -> null
    }
}

/** POST /workspaces */
@Serializable
data class WorkspaceSummary(val id: String, val name: String, val createdAt: Long, val expiresAt: Long? = null)

@Serializable
data class CreateWorkspaceRequest(
    val workspace: WorkspaceSummary,
    val device: DeviceInfo,
    val pairingToken: String,
    val tokenExpiresAt: Long,
)

/** POST /workspaces/:id/join */
@Serializable
data class JoinWorkspaceRequest(val pairingToken: String, val device: DeviceInfo)

@Serializable
data class JoinedWorkspaceSummary(val id: String, val name: String, val ownerDeviceId: String, val expiresAt: Long? = null)

@Serializable
data class JoinWorkspaceResponse(val workspace: JoinedWorkspaceSummary, val devices: List<PresenceEntry>)

/** POST /workspaces/:id/pairing-token (owner only) */
@Serializable
data class RotatePairingRequest(val deviceId: String, val pairingToken: String, val tokenExpiresAt: Long)

/** POST /workspaces/:id/revoke (owner only) */
@Serializable
data class RevokeDeviceRequest(val ownerDeviceId: String, val deviceId: String)

/** POST /workspaces/:id/capabilities — a device updates what it advertises. */
@Serializable
data class SetCapabilitiesRequest(val deviceId: String, val capabilities: List<String>)
