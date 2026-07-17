package com.screenmesh.sync

import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.RatchetMessageHeader
import com.screenmesh.crypto.SealParams
import com.screenmesh.crypto.decryptEnvelope
import com.screenmesh.crypto.importEncryptionPublicKey
import com.screenmesh.crypto.importPublicKey
import com.screenmesh.crypto.initRatchetSession
import com.screenmesh.crypto.ratchetDecrypt
import com.screenmesh.crypto.ratchetEncrypt
import com.screenmesh.crypto.sealEnvelope
import com.screenmesh.crypto.verifyEnvelope
import com.screenmesh.protocol.CreateObjectPayload
import com.screenmesh.protocol.Delivery
import com.screenmesh.protocol.DeliveryStatuses
import com.screenmesh.protocol.Device
import com.screenmesh.protocol.DeviceTypes
import com.screenmesh.protocol.EnvelopeJson
import com.screenmesh.protocol.MeshObject
import com.screenmesh.protocol.ObjectRefPayload
import com.screenmesh.protocol.Operation
import com.screenmesh.protocol.OperationTypes
import com.screenmesh.protocol.PresenceEntry
import com.screenmesh.protocol.RevokeDevicePayload
import com.screenmesh.protocol.SendOptions
import com.screenmesh.protocol.SendToDevicePayload
import com.screenmesh.protocol.toEnvelope
import com.screenmesh.protocol.toJson
import com.screenmesh.transport.RelayTransport
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKey

/**
 * Kotlin mirror of packages/sync/src/engine.ts's MeshEngine — the layer
 * tying protocol/crypto/transport together: UI action -> op -> encrypt ->
 * transport, and the reverse on receive: verify -> decrypt -> apply.
 *
 * This is a DELIBERATELY REDUCED port, not the full engine. Everything
 * below lives in memory only (ConcurrentHashMaps) — there is no Android
 * persistence layer yet (packages/storage's Dexie/IndexedDB has no port
 * here), so restarting the app loses all objects/deliveries/ratchet
 * sessions. Explicitly NOT ported in this pass (see docs/Android.md):
 *  - Store-carry-forward (the outbox/carried tables, periodicSweep,
 *    CARRY_BUNDLE) — undeliverable ops are just dropped, not queued.
 *  - Yjs collaborative text editing (YJS_UPDATE, editText).
 *  - Secure file drop chunking (FILE_CHUNK, sendFileChunks).
 *  - continueOnDevice / CONTINUE_ON_DEVICE.
 *  - UPDATE_OBJECT, DELETE_OBJECT, PIN_OBJECT, MOVE_OBJECT, ADD_ATTACHMENT.
 * Implemented: identity-backed pairwise ratchet sessions, sendObject
 * (CREATE_OBJECT + SEND_TO_DEVICE), markOpened/acceptObject/rejectObject,
 * revokeDevice, resolveCapability, presence sync, and the
 * verify-then-decrypt-then-apply receive path for the six op types listed
 * in applyOp below.
 */

@Serializable
private data class OpsEnvelope(val ops: List<Operation>)

data class EngineConfig(
    val identity: DeviceIdentity,
    val workspaceId: String,
    /** Pairing secret — the raw workspace key from the QR. Seeds every
     *  pairwise ratchet session (docs/Security.md §5); never used to
     *  encrypt anything directly. */
    val workspaceKey: SecretKey,
    /** Only this device may revoke devices. */
    val ownerDeviceId: String,
    val transport: RelayTransport,
    val now: () -> Long = { System.currentTimeMillis() },
    /**
     * Fires whenever a NEW object (not a duplicate/already-known one)
     * arrives from another device, after every op in its envelope has
     * been applied.
     */
    val onObjectReceived: ((MeshObject, String) -> Unit)? = null,
)

class MeshEngine(private val cfg: EngineConfig) {
    private var seq = 0
    private val peerKeys = ConcurrentHashMap<String, Ed25519PublicKeyParameters>()
    private val ratchets = ConcurrentHashMap<String, com.screenmesh.crypto.RatchetSession>()
    private val objects = ConcurrentHashMap<String, MeshObject>()
    private val deliveries = ConcurrentHashMap<String, Delivery>()
    private val devices = ConcurrentHashMap<String, Device>()
    private val seen: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private lateinit var pairingSecret: ByteArray

    private val me: String get() = cfg.identity.deviceId
    private fun now(): Long = cfg.now()

    fun start() {
        pairingSecret = cfg.workspaceKey.encoded
        cfg.transport.onMessage { data -> handleIncoming(data) }
        cfg.transport.subscribePresence { entries -> applyPresence(entries) }
        cfg.transport.open()
    }

    fun stop() {
        cfg.transport.disconnect()
    }

    /** Create an object locally and send it to each recipient device. */
    fun sendObject(type: String, content: JsonElement, recipientIds: List<String>, options: SendOptions = SendOptions()): MeshObject {
        val nowMs = now()
        val obj = MeshObject(
            id = UUID.randomUUID().toString(),
            workspaceId = cfg.workspaceId,
            type = type,
            content = content,
            createdBy = me,
            createdAt = nowMs,
            updatedAt = nowMs,
            expiresAt = options.expiresAt,
        )
        objects[obj.id] = obj

        for (recipientId in recipientIds) {
            val delivery = Delivery(
                id = UUID.randomUUID().toString(),
                objectId = obj.id,
                sourceDeviceId = me,
                destinationDeviceId = recipientId,
                status = DeliveryStatuses.QUEUED,
                createdAt = nowMs,
                options = if (!options.isEmpty) options else null,
            )
            deliveries[delivery.id] = delivery

            val ops = listOf(
                makeOp(
                    OperationTypes.CREATE_OBJECT,
                    obj.id,
                    Json.encodeToJsonElement(CreateObjectPayload.serializer(), CreateObjectPayload(obj)),
                ),
                makeOp(
                    OperationTypes.SEND_TO_DEVICE,
                    obj.id,
                    Json.encodeToJsonElement(SendToDevicePayload.serializer(), SendToDevicePayload(obj.id, options)),
                ),
            )
            val sentLive = sendOps(recipientId, ops)
            if (sentLive) {
                deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.SENDING)
            }
        }
        return obj
    }

    /** Recipient-side: mark an object opened and notify the sender. */
    fun markOpened(objectId: String) {
        val obj = objects[objectId] ?: return
        if (obj.createdBy == me) return
        val delivery = deliveries.values.find { it.objectId == objectId && it.destinationDeviceId == me } ?: return
        if (delivery.status == DeliveryStatuses.OPENED || delivery.status == DeliveryStatuses.PENDING) return
        deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.OPENED, openedAt = now())
        sendOps(
            obj.createdBy,
            listOf(makeOp(OperationTypes.MARK_OPENED, objectId, Json.encodeToJsonElement(ObjectRefPayload.serializer(), ObjectRefPayload(objectId)))),
        )
        if (delivery.options?.deleteAfterOpening == true) {
            deleteObjectLocal(objectId)
        }
    }

    /** Recipient-side: accept a requireConfirmation delivery. */
    fun acceptObject(objectId: String) {
        val delivery = deliveries.values.find {
            it.objectId == objectId && it.destinationDeviceId == me && it.status == DeliveryStatuses.PENDING
        } ?: return
        val nowMs = now()
        deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.DELIVERED, deliveredAt = nowMs)
        sendOps(
            delivery.sourceDeviceId,
            listOf(makeOp(OperationTypes.MARK_DELIVERED, objectId, Json.encodeToJsonElement(ObjectRefPayload.serializer(), ObjectRefPayload(objectId)))),
        )
    }

    /** Recipient-side: decline a requireConfirmation delivery. */
    fun rejectObject(objectId: String) {
        val delivery = deliveries.values.find {
            it.objectId == objectId && it.destinationDeviceId == me && it.status == DeliveryStatuses.PENDING
        } ?: return
        sendOps(
            delivery.sourceDeviceId,
            listOf(makeOp(OperationTypes.REJECT_OBJECT, objectId, Json.encodeToJsonElement(ObjectRefPayload.serializer(), ObjectRefPayload(objectId)))),
        )
        deleteObjectLocal(objectId)
    }

    /** Local-only delete: removes the object and its delivery rows. */
    fun deleteObjectLocal(objectId: String) {
        deliveries.values.filter { it.objectId == objectId }.forEach { deliveries.remove(it.id) }
        objects.remove(objectId)
    }

    /** Capability routing (docs/Roadmap.md Phase 5). Online devices first. */
    fun resolveCapability(capability: String): List<Device> =
        devices.values
            .filter { it.id != me && it.capabilities?.contains(capability) == true }
            .sortedBy { if (it.status == "online") 0 else 1 }

    /** Owner-side revocation: tell the remaining devices and drop the device locally. */
    fun revokeDevice(deviceId: String) {
        val others = devices.values.filter { it.id != me && it.id != deviceId }
        for (device in others) {
            sendOps(
                device.id,
                listOf(makeOp(OperationTypes.REVOKE_DEVICE, null, Json.encodeToJsonElement(RevokeDevicePayload.serializer(), RevokeDevicePayload(deviceId)))),
            )
        }
        devices.remove(deviceId)
        peerKeys.remove(deviceId)
        ratchets.remove(deviceId)
    }

    fun objectsSnapshot(): List<MeshObject> = objects.values.toList()

    fun deliveriesSnapshot(): List<Delivery> = deliveries.values.toList()

    fun devicesSnapshot(): List<Device> = devices.values.toList()

    // --- internals ---

    /**
     * Get-or-create the Double Ratchet session with a peer (docs/Security.md
     * §5). Bootstraps from the peer's X25519 identity key (learned via
     * presence) and the workspace pairing secret.
     */
    private fun ratchetSessionFor(peerDeviceId: String): com.screenmesh.crypto.RatchetSession {
        ratchets[peerDeviceId]?.let { return it }
        val peer = devices[peerDeviceId]
            ?: throw IllegalStateException("cannot start a ratchet session with $peerDeviceId: unknown device")
        val peerEncryptionKeyB64 = peer.encryptionKey
            ?: throw IllegalStateException("cannot start a ratchet session with $peerDeviceId: no encryption key on file")
        val session = initRatchetSession(
            workspaceId = cfg.workspaceId,
            myDeviceId = me,
            myIdentityPublic = cfg.identity.encryptionPublicKey,
            myIdentityPrivate = cfg.identity.encryptionPrivateKey,
            peerDeviceId = peerDeviceId,
            peerIdentityPublic = importEncryptionPublicKey(peerEncryptionKeyB64),
            pairingSecret = pairingSecret,
        )
        ratchets[peerDeviceId] = session
        return session
    }

    private fun makeOp(type: String, objectId: String?, payload: JsonElement): Operation = Operation(
        operationId = UUID.randomUUID().toString(),
        deviceId = me,
        workspaceId = cfg.workspaceId,
        type = type,
        objectId = objectId,
        timestamp = now(),
        payload = payload,
    )

    /**
     * Seal ops into an envelope and send over the relay. Returns whether it
     * went out live. Unlike the TS engine, there's no outbox to fall back
     * to here — an undeliverable send is simply dropped (see the module
     * doc comment: store-carry-forward is not ported in this pass).
     */
    private fun sendOps(recipientId: String, ops: List<Operation>): Boolean {
        seq += 1
        val session = ratchetSessionFor(recipientId)
        val encrypted = ratchetEncrypt(session)
        val plaintext = Json.encodeToString(OpsEnvelope.serializer(), OpsEnvelope(ops)).toByteArray(StandardCharsets.UTF_8)
        val envelope = sealEnvelope(
            SealParams(
                identity = cfg.identity,
                recipientDeviceId = recipientId,
                workspaceId = cfg.workspaceId,
                messageKey = encrypted.messageKey,
                ratchetHeader = encrypted.header,
                plaintext = plaintext,
                sequenceNumber = seq,
                createdAt = now(),
            ),
        )
        if (cfg.transport.isConnected) {
            try {
                cfg.transport.sendEnvelope(envelope.toJson())
                return true
            } catch (_: Exception) {
                // fall through — dropped, no outbox in this pass
            }
        }
        return false
    }

    private fun handleIncoming(data: ByteArray) {
        val json = Json.decodeFromString(EnvelopeJson.serializer(), String(data, StandardCharsets.UTF_8))
        val envelope = json.toEnvelope()
        val nowMs = now()

        if (envelope.recipientDeviceId != me) return
        if (envelope.workspaceId != cfg.workspaceId) return
        if (!seen.add(envelope.messageId)) return

        // Authenticity MUST be checked before the ratchet header is trusted
        // for anything — deriving a message key mutates session state, and
        // a forged header must never be allowed to do that before
        // verification. See SecureEnvelopeCodec.kt's doc comment.
        val senderKey = keyFor(envelope.senderDeviceId)
        verifyEnvelope(envelope, senderKey, nowMs)

        val session = ratchetSessionFor(envelope.senderDeviceId)
        val messageKey = ratchetDecrypt(
            session,
            RatchetMessageHeader(envelope.ratchetPublicKeyB64, envelope.messageNumber, envelope.previousChainLength),
        )
        val plaintext = decryptEnvelope(envelope, messageKey)

        val opsEnvelope = Json.decodeFromString(OpsEnvelope.serializer(), String(plaintext, StandardCharsets.UTF_8))
        val newObjects = mutableListOf<MeshObject>()
        for (op in opsEnvelope.ops) {
            applyOp(envelope.senderDeviceId, op)?.let { newObjects.add(it) }
        }
        // Fired only after every op in the envelope is applied, matching
        // the TS engine's ordering guarantee (see engine.ts's handleIncoming
        // doc comment): a CREATE_OBJECT's sibling SEND_TO_DEVICE has
        // already created the delivery record by the time this fires.
        for (obj in newObjects) {
            cfg.onObjectReceived?.invoke(obj, envelope.senderDeviceId)
        }
    }

    /**
     * Applies one op, returning a newly-received MeshObject if this op
     * created one (so handleIncoming can defer onObjectReceived until the
     * whole envelope is applied). Only the six op types below are
     * implemented in this pass — everything else is silently ignored,
     * matching the TS engine's `default: break` for op types it doesn't
     * recognize (see the module doc comment for what's deferred and why).
     */
    private fun applyOp(senderId: String, op: Operation): MeshObject? {
        val nowMs = now()
        var newObject: MeshObject? = null
        when (op.type) {
            OperationTypes.CREATE_OBJECT -> {
                val payload = Json.decodeFromJsonElement(CreateObjectPayload.serializer(), op.payload)
                if (!objects.containsKey(payload.`object`.id)) {
                    objects[payload.`object`.id] = payload.`object`
                    newObject = payload.`object`
                }
            }
            OperationTypes.SEND_TO_DEVICE -> {
                val payload = Json.decodeFromJsonElement(SendToDevicePayload.serializer(), op.payload)
                recordIncomingDelivery(senderId, payload.objectId, payload.options, nowMs)
            }
            OperationTypes.MARK_DELIVERED -> {
                val payload = Json.decodeFromJsonElement(ObjectRefPayload.serializer(), op.payload)
                val delivery = deliveries.values.find {
                    it.objectId == payload.objectId && it.sourceDeviceId == me && it.destinationDeviceId == senderId
                }
                if (delivery != null && delivery.status != DeliveryStatuses.OPENED) {
                    deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.DELIVERED, deliveredAt = nowMs)
                }
            }
            OperationTypes.MARK_OPENED -> {
                val payload = Json.decodeFromJsonElement(ObjectRefPayload.serializer(), op.payload)
                val delivery = deliveries.values.find {
                    it.objectId == payload.objectId && it.sourceDeviceId == me && it.destinationDeviceId == senderId
                }
                if (delivery != null) {
                    deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.OPENED, openedAt = nowMs)
                }
            }
            OperationTypes.REJECT_OBJECT -> {
                val payload = Json.decodeFromJsonElement(ObjectRefPayload.serializer(), op.payload)
                val delivery = deliveries.values.find {
                    it.objectId == payload.objectId && it.sourceDeviceId == me && it.destinationDeviceId == senderId
                }
                if (delivery != null) {
                    deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.REJECTED)
                }
            }
            OperationTypes.REVOKE_DEVICE -> {
                val payload = Json.decodeFromJsonElement(RevokeDevicePayload.serializer(), op.payload)
                if (senderId == cfg.ownerDeviceId) {
                    devices.remove(payload.deviceId)
                    peerKeys.remove(payload.deviceId)
                    ratchets.remove(payload.deviceId)
                }
            }
            else -> Unit
        }
        return newObject
    }

    private fun applyPresence(entries: List<PresenceEntry>) {
        for (entry in entries) {
            devices[entry.id] = Device(
                id = entry.id,
                name = entry.name,
                publicKey = entry.publicKey,
                encryptionKey = entry.encryptionKey,
                type = entry.type,
                role = if (entry.type == DeviceTypes.PHONE) "input" else "editor",
                capabilities = entry.capabilities,
                lastSeenAt = entry.lastSeenAt,
                status = if (entry.online) "online" else "offline",
                trusted = true,
            )
        }
        // The roster is authoritative: devices no longer in it were revoked.
        val ids = entries.map { it.id }.toSet()
        devices.keys.filter { it !in ids }.forEach { devices.remove(it) }
    }

    /**
     * Recipient-side bookkeeping for SEND_TO_DEVICE: record the delivery
     * (gated "pending" if the sender required confirmation) and ack the
     * sender.
     */
    private fun recordIncomingDelivery(senderId: String, objectId: String, options: SendOptions?, nowMs: Long) {
        val existing = deliveries.values.find {
            it.objectId == objectId && it.destinationDeviceId == me && it.sourceDeviceId == senderId
        }
        val gated = options?.requireConfirmation == true
        if (existing == null) {
            val delivery = Delivery(
                id = UUID.randomUUID().toString(),
                objectId = objectId,
                sourceDeviceId = senderId,
                destinationDeviceId = me,
                status = if (gated) DeliveryStatuses.PENDING else DeliveryStatuses.DELIVERED,
                createdAt = nowMs,
                deliveredAt = if (gated) null else nowMs,
                options = options,
            )
            deliveries[delivery.id] = delivery
        }
        if (!gated) {
            sendOps(
                senderId,
                listOf(makeOp(OperationTypes.MARK_DELIVERED, objectId, Json.encodeToJsonElement(ObjectRefPayload.serializer(), ObjectRefPayload(objectId)))),
            )
        }
    }

    private fun keyFor(deviceId: String): Ed25519PublicKeyParameters {
        peerKeys[deviceId]?.let { return it }
        val device = devices[deviceId] ?: throw IllegalStateException("unknown sender device $deviceId")
        val key = importPublicKey(device.publicKey)
        peerKeys[deviceId] = key
        return key
    }
}
