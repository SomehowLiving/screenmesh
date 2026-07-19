package com.screenmesh.sync

import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.RatchetMessageHeader
import com.screenmesh.crypto.SealParams
import com.screenmesh.crypto.decryptEnvelope
import com.screenmesh.crypto.fromBase64
import com.screenmesh.crypto.importEncryptionPublicKey
import com.screenmesh.crypto.importPublicKey
import com.screenmesh.crypto.initRatchetSession
import com.screenmesh.crypto.ratchetDecrypt
import com.screenmesh.crypto.ratchetEncrypt
import com.screenmesh.crypto.sealEnvelope
import com.screenmesh.crypto.toBase64
import com.screenmesh.crypto.verifyEnvelope
import com.screenmesh.protocol.CarryBundlePayload
import com.screenmesh.protocol.ContinueOnDevicePayload
import com.screenmesh.protocol.CreateObjectPayload
import com.screenmesh.protocol.DEFAULT_HOP_LIMIT
import com.screenmesh.protocol.Delivery
import com.screenmesh.protocol.DeliveryBundle
import com.screenmesh.protocol.DeliveryStatuses
import com.screenmesh.protocol.Device
import com.screenmesh.protocol.DeviceTypes
import com.screenmesh.protocol.EnvelopeJson
import com.screenmesh.protocol.FileChunkMeta
import com.screenmesh.protocol.FileChunkPayload
import com.screenmesh.protocol.FileContent
import com.screenmesh.protocol.MeshObject
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.protocol.ObjectRefPayload
import com.screenmesh.protocol.Operation
import com.screenmesh.protocol.OperationTypes
import com.screenmesh.protocol.PresenceEntry
import com.screenmesh.protocol.RevokeDevicePayload
import com.screenmesh.protocol.SendOptions
import com.screenmesh.protocol.SendToDevicePayload
import com.screenmesh.protocol.UpdateObjectPayload
import com.screenmesh.protocol.toEnvelope
import com.screenmesh.protocol.toJson
import com.screenmesh.transport.RelayTransport
import com.screenmesh.transport.TransportStatus
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.SecretKey

private const val OUTBOX_TTL_MS = 7L * 24 * 60 * 60 * 1000
private const val SEEN_RETENTION_MS = 7L * 24 * 60 * 60 * 1000
private const val DEFAULT_SWEEP_INTERVAL_MS = 15_000L

/**
 * Secure file drop: files whose base64 payload exceeds this many
 * characters (~150 KB raw) are split into chunks, each its own envelope
 * (own ratchet message, own carry-eligibility), rather than one giant
 * envelope. Keeps individual messages small regardless of file size.
 */
private const val FILE_CHUNK_SIZE_B64 = 200_000

/**
 * Kotlin mirror of packages/sync/src/engine.ts's MeshEngine — the layer
 * tying protocol/crypto/transport together: UI action -> op -> encrypt ->
 * transport, and the reverse on receive: verify -> decrypt -> apply.
 *
 * This is a REDUCED port, not the full engine. Object/delivery/ratchet
 * state lives in memory only (`ConcurrentHashMap`s) — there is no Android
 * storage layer (`packages/storage`'s Dexie/IndexedDB has no port here),
 * so restarting the app loses all objects, deliveries, and ratchet
 * sessions (a lost ratchet session just re-bootstraps from the identity
 * keys + pairing secret, exactly as the ratchet design intends — see
 * docs/Security.md §5). This is not a regression versus the desktop
 * agent (`apps/agent`): it deliberately keeps the same scope too — see
 * apps/agent/src/state.ts's doc comment. Identity + session DO survive a
 * restart, via `LocalState.kt`.
 *
 * Implemented this pass: identity-backed pairwise ratchet sessions,
 * `sendObject` (CREATE_OBJECT + SEND_TO_DEVICE, or chunked `FILE_CHUNK`
 * sends for large files/images — see `sendFileChunks`), `markOpened` /
 * `acceptObject` / `rejectObject`, `updateObjectContent`,
 * `continueOnDevice`, `revokeDevice`, `resolveCapability`, presence sync,
 * store-carry-forward (outbox/carried maps, `periodicSweep`,
 * `CARRY_BUNDLE`), and the verify -> ratchet-decrypt -> apply receive path
 * for CREATE_OBJECT, SEND_TO_DEVICE, UPDATE_OBJECT, DELETE_OBJECT,
 * CONTINUE_ON_DEVICE, MARK_DELIVERED, MARK_OPENED, REJECT_OBJECT,
 * FILE_CHUNK, CARRY_BUNDLE, and REVOKE_DEVICE.
 *
 * Explicitly NOT ported (unimplemented ops are silently ignored, matching
 * the TS engine's `default: break` — a scope line, not a bug): Yjs
 * collaborative text editing (`YJS_UPDATE`, `editText`) — no
 * Yjs-for-Kotlin port exists, and the realistic options (yrs' JVM/Kotlin
 * bindings via JNI/JNA) need a Rust + Android NDK cross-compilation
 * toolchain this pass didn't set up; a from-scratch reimplementation of
 * Yjs's binary update format and YATA merge algorithm is a large,
 * easy-to-get-subtly-wrong undertaking on its own. See docs/Android.md.
 */

/** A newly-arrived hand-off request — mirrors the TS engine's `settings["focusObject"]` write. */
data class FocusRequest(val objectId: String, val fromDeviceId: String, val at: Long)

@Serializable
private data class OpsEnvelope(val ops: List<Operation>)

/** Reassembly state for one in-progress FILE_CHUNK transfer. */
private class IncomingFileChunks(val total: Int) {
    val chunks = ConcurrentHashMap<Int, String>()

    @Volatile var meta: FileChunkMeta? = null
}

/** Store-carry-forward: our own not-yet-delivered sends, waiting for the recipient or a carrier. */
private data class OutboxEntry(
    val bundleId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val encryptedPayload: ByteArray,
    val createdAt: Long,
    val expiresAt: Long,
    val hopLimit: Int,
    val offeredTo: List<String> = emptyList(),
)

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
    /** Override the periodic sweep cadence (tests may want a short interval). */
    val sweepIntervalMs: Long = DEFAULT_SWEEP_INTERVAL_MS,
    /**
     * Fires whenever a NEW object (not a duplicate/already-known one)
     * arrives from another device, after every op in its envelope has
     * been applied.
     */
    val onObjectReceived: ((MeshObject, String) -> Unit)? = null,
    /** Fires when another device hands an object off to us via continueOnDevice. */
    val onContinueOnDevice: ((FocusRequest) -> Unit)? = null,
)

class MeshEngine(private val cfg: EngineConfig) {
    private var seq = 0
    private val peerKeys = ConcurrentHashMap<String, Ed25519PublicKeyParameters>()
    private val ratchets = ConcurrentHashMap<String, com.screenmesh.crypto.RatchetSession>()
    private val objects = ConcurrentHashMap<String, MeshObject>()
    private val deliveries = ConcurrentHashMap<String, Delivery>()
    private val devices = ConcurrentHashMap<String, Device>()

    /** messageId -> seenAt, for replay dedup + SEEN_RETENTION_MS pruning. */
    private val seenAt = ConcurrentHashMap<String, Long>()

    /** Our own sends that couldn't be delivered live, keyed by bundleId (== envelope messageId). */
    private val outbox = ConcurrentHashMap<String, OutboxEntry>()

    /** Bundles we're carrying toward their true destination on someone else's behalf. */
    private val carried = ConcurrentHashMap<String, DeliveryBundle>()

    /** In-progress file reassembly buffers, keyed by fileId (in-memory only — a
     *  reload mid-transfer loses partial progress and needs a re-send). */
    private val incomingChunks = ConcurrentHashMap<String, IncomingFileChunks>()

    private val sweeping = AtomicBoolean(false)
    private var sweepExecutor: ScheduledExecutorService? = null

    private lateinit var pairingSecret: ByteArray

    private val me: String get() = cfg.identity.deviceId
    private fun now(): Long = cfg.now()

    fun start() {
        pairingSecret = cfg.workspaceKey.encoded
        cfg.transport.onMessage { data ->
            try {
                handleIncoming(data)
            } catch (e: Exception) {
                // Matches the TS engine's handleIncoming(...).catch(console.error) —
                // a malformed envelope or a forged/corrupt one that fails
                // verify/decrypt must not crash the message-dispatch thread.
                e.printStackTrace()
            }
        }
        cfg.transport.subscribePresence { entries -> applyPresence(entries) }
        cfg.transport.onStatusChange { status -> if (status == TransportStatus.CONNECTED) drainOutbox() }
        cfg.transport.open()

        periodicSweep()
        val executor = Executors.newSingleThreadScheduledExecutor()
        executor.scheduleWithFixedDelay({ periodicSweep() }, cfg.sweepIntervalMs, cfg.sweepIntervalMs, TimeUnit.MILLISECONDS)
        sweepExecutor = executor
    }

    fun stop() {
        sweepExecutor?.shutdown()
        sweepExecutor = null
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

        // Secure file drop: large files travel as a sequence of small chunk
        // envelopes instead of one giant one (see FILE_CHUNK_SIZE_B64).
        val fileContent = if (type == MeshObjectTypes.FILE || type == MeshObjectTypes.IMAGE) {
            try {
                Json.decodeFromJsonElement(FileContent.serializer(), content)
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        val chunked = fileContent != null && fileContent.dataB64.length > FILE_CHUNK_SIZE_B64

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

            // Real object deliveries are carry-eligible: if this recipient is
            // unreachable directly, another online device may later carry the
            // encrypted bundle on our behalf (docs/Architecture.md §2).
            val sentLive = if (chunked && fileContent != null) {
                sendFileChunks(obj, fileContent, recipientId, options)
            } else {
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
                sendOps(recipientId, ops, DEFAULT_HOP_LIMIT)
            }
            if (sentLive) {
                deliveries[delivery.id] = delivery.copy(status = DeliveryStatuses.SENDING)
            }
        }
        return obj
    }

    /**
     * Send a large file as a sequence of small chunk envelopes; each chunk
     * is its own carry-eligible envelope. Returns true only if every chunk
     * went out live (matching sendOps' live/queued return contract).
     */
    private fun sendFileChunks(obj: MeshObject, file: FileContent, recipientId: String, options: SendOptions): Boolean {
        val totalChunks = (file.dataB64.length + FILE_CHUNK_SIZE_B64 - 1) / FILE_CHUNK_SIZE_B64
        var allLive = true
        for (i in 0 until totalChunks) {
            val start = i * FILE_CHUNK_SIZE_B64
            val end = minOf(start + FILE_CHUNK_SIZE_B64, file.dataB64.length)
            val meta = if (i == 0) {
                FileChunkMeta(
                    objectType = obj.type,
                    name = file.name,
                    mimeType = file.mimeType,
                    size = file.size,
                    createdBy = obj.createdBy,
                    createdAt = obj.createdAt,
                    expiresAt = obj.expiresAt,
                    options = if (!options.isEmpty) options else null,
                )
            } else {
                null
            }
            val payload = FileChunkPayload(
                fileId = obj.id,
                chunkIndex = i,
                totalChunks = totalChunks,
                dataB64 = file.dataB64.substring(start, end),
                meta = meta,
            )
            val sentLive = sendOps(
                recipientId,
                listOf(makeOp(OperationTypes.FILE_CHUNK, obj.id, Json.encodeToJsonElement(FileChunkPayload.serializer(), payload))),
                DEFAULT_HOP_LIMIT,
            )
            if (!sentLive) allLive = false
        }
        return allLive
    }

    /**
     * Collaborative text editing (editText) is NOT ported — no Yjs for
     * Kotlin. This is the plain last-write-wins path only.
     */
    fun updateObjectContent(objectId: String, content: JsonElement) {
        val existing = objects[objectId] ?: return
        val nowMs = now()
        objects[objectId] = existing.copy(content = content, updatedAt = nowMs)
        broadcastOps(
            listOf(
                makeOp(
                    OperationTypes.UPDATE_OBJECT,
                    objectId,
                    Json.encodeToJsonElement(UpdateObjectPayload.serializer(), UpdateObjectPayload(objectId, content, nowMs)),
                ),
            ),
        )
    }

    /**
     * Hand an object off to another device: deliver it (idempotent if the
     * device already has it) and ask that device to open it for editing.
     * Unlike the TS engine, this never seeds a Yjs update alongside it —
     * no Yjs port exists here.
     */
    fun continueOnDevice(objectId: String, deviceId: String) {
        val obj = objects[objectId] ?: return
        val ops = listOf(
            makeOp(OperationTypes.CREATE_OBJECT, objectId, Json.encodeToJsonElement(CreateObjectPayload.serializer(), CreateObjectPayload(obj))),
            makeOp(OperationTypes.SEND_TO_DEVICE, objectId, Json.encodeToJsonElement(SendToDevicePayload.serializer(), SendToDevicePayload(objectId, SendOptions()))),
            makeOp(OperationTypes.CONTINUE_ON_DEVICE, objectId, Json.encodeToJsonElement(ContinueOnDevicePayload.serializer(), ContinueOnDevicePayload(objectId))),
        )
        sendOps(deviceId, ops, DEFAULT_HOP_LIMIT)
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

    /** Send the same ops to every other device in the workspace. */
    private fun broadcastOps(ops: List<Operation>) {
        val others = devices.values.filter { it.id != me }
        for (device in others) {
            sendOps(device.id, ops)
        }
    }

    /**
     * Seal ops into an envelope; send live or queue in the outbox.
     * `hopLimit` bounds store-carry-forward fan-out for THIS bundle if it
     * ends up queued (0 = never offered to a carrier — appropriate for
     * acks/control ops, which are cheap to just re-send once back online).
     */
    private fun sendOps(recipientId: String, ops: List<Operation>, hopLimit: Int = 0): Boolean {
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
        val bytes = Json.encodeToString(EnvelopeJson.serializer(), envelope.toJson()).toByteArray(StandardCharsets.UTF_8)

        if (deliverBytes(bytes)) return true

        outbox[envelope.messageId] = OutboxEntry(
            bundleId = envelope.messageId,
            sourceDeviceId = me,
            destinationDeviceId = recipientId,
            encryptedPayload = bytes,
            createdAt = envelope.createdAt,
            expiresAt = envelope.createdAt + OUTBOX_TTL_MS,
            hopLimit = hopLimit,
            offeredTo = emptyList(),
        )
        return false
    }

    /** Delivers over the relay if connected. Returns false if not — caller queues for later. */
    private fun deliverBytes(bytes: ByteArray): Boolean {
        if (!cfg.transport.isConnected) return false
        return try {
            val json = Json.decodeFromString(EnvelopeJson.serializer(), String(bytes, StandardCharsets.UTF_8))
            cfg.transport.sendEnvelope(json)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Like deliverBytes, but for envelopes we're carrying on someone else's
     * behalf: over the relay this MUST use forwardEnvelope, not
     * sendEnvelope — the relay rejects "envelope" messages whose inner
     * senderDeviceId doesn't match our own authenticated connection, which
     * is exactly true here (we're relaying, not sending our own).
     */
    private fun forwardCarriedBytes(bytes: ByteArray): Boolean {
        if (!cfg.transport.isConnected) return false
        return try {
            val json = Json.decodeFromString(EnvelopeJson.serializer(), String(bytes, StandardCharsets.UTF_8))
            cfg.transport.forwardEnvelope(json)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun drainOutbox() {
        val nowMs = now()
        outbox.values.filter { it.expiresAt < nowMs }.forEach { outbox.remove(it.bundleId) }
        for (entry in outbox.values.toList()) {
            if (deliverBytes(entry.encryptedPayload)) {
                outbox.remove(entry.bundleId)
            }
        }
    }

    /**
     * Store-carry-forward, part 1: for each bundle this device is CARRYING
     * on behalf of someone else, forward it the moment the true destination
     * looks reachable — same encrypted bytes, so the destination verifies
     * and decrypts exactly as if it arrived directly from the sender.
     */
    private fun attemptCarriedDelivery() {
        val nowMs = now()
        carried.values.filter { it.expiresAt < nowMs }.forEach { carried.remove(it.bundleId) }
        for (bundle in carried.values.toList()) {
            val dest = devices[bundle.destinationDeviceId]
            if (dest?.status != "online") continue
            if (forwardCarriedBytes(bundle.encryptedPayload)) {
                carried.remove(bundle.bundleId)
            }
        }
    }

    /**
     * Store-carry-forward, part 2: for our own outbox bundles stuck behind
     * an offline destination, hand a copy to one currently-online peer
     * (never the destination itself) as a carrier — bounded by hopLimit so
     * fan-out can't run away.
     */
    private fun offerCarrying() {
        if (outbox.isEmpty()) return
        val onlinePeers = devices.values.filter { it.id != me && it.status == "online" }
        if (onlinePeers.isEmpty()) return

        for (entry in outbox.values.toList()) {
            if (entry.hopLimit <= 0) continue
            val carrier = onlinePeers.find { it.id != entry.destinationDeviceId && it.id !in entry.offeredTo } ?: continue

            val nextHopLimit = entry.hopLimit - 1
            val sent = sendOps(
                carrier.id,
                listOf(
                    makeOp(
                        OperationTypes.CARRY_BUNDLE,
                        null,
                        Json.encodeToJsonElement(
                            CarryBundlePayload.serializer(),
                            CarryBundlePayload(
                                bundleId = entry.bundleId,
                                sourceDeviceId = entry.sourceDeviceId,
                                destinationDeviceId = entry.destinationDeviceId,
                                encryptedPayloadB64 = toBase64(entry.encryptedPayload),
                                createdAt = entry.createdAt,
                                expiresAt = entry.expiresAt,
                                hopLimit = nextHopLimit,
                            ),
                        ),
                    ),
                ),
            )
            if (sent) {
                outbox[entry.bundleId] = entry.copy(hopLimit = nextHopLimit, offeredTo = entry.offeredTo + carrier.id)
            }
        }
    }

    /** Delete MeshObjects whose expiresAt has passed; mark their in-flight deliveries "expired". */
    private fun sweepExpiredObjects() {
        val nowMs = now()
        val expired = objects.values.filter { it.expiresAt != null && it.expiresAt < nowMs }
        for (obj in expired) {
            deliveries.values.filter { it.objectId == obj.id }.forEach { d ->
                if (d.status != DeliveryStatuses.OPENED) {
                    deliveries[d.id] = d.copy(status = DeliveryStatuses.EXPIRED)
                }
            }
            objects.remove(obj.id)
        }
    }

    /**
     * The TS engine only prunes db.seen once at startup (it's a persistent
     * IndexedDB table). seenAt here is in-memory and lives for the whole
     * process, so it's pruned on every sweep instead — strictly safer
     * (bounded memory) and behaviorally equivalent for dedup purposes.
     */
    private fun pruneSeen() {
        val cutoff = now() - SEEN_RETENTION_MS
        seenAt.entries.filter { it.value < cutoff }.forEach { seenAt.remove(it.key) }
    }

    /**
     * Runs on a timer (and once at startup) to advance expiry and
     * store-carry-forward without needing a user action. Guarded against
     * re-entrancy: the timer and a transport status callback could both
     * trigger this close together, and running attemptCarriedDelivery/
     * offerCarrying concurrently with itself would let both invocations
     * read the carried/outbox maps before either removes its entry —
     * forwarding (or offering) the same bundle twice.
     */
    private fun periodicSweep() {
        if (!sweeping.compareAndSet(false, true)) return
        try {
            sweepExpiredObjects()
            pruneSeen()
            attemptCarriedDelivery()
            offerCarrying()
        } catch (e: Exception) {
            e.printStackTrace()
        } finally {
            sweeping.set(false)
        }
    }

    private fun handleIncoming(data: ByteArray) {
        val json = Json.decodeFromString(EnvelopeJson.serializer(), String(data, StandardCharsets.UTF_8))
        val envelope = json.toEnvelope()
        val nowMs = now()

        if (envelope.recipientDeviceId != me) return
        if (envelope.workspaceId != cfg.workspaceId) return
        // Dedup check only — NOT marked seen yet. Marking happens after a
        // successful decrypt below, matching the TS engine (db.seen.add
        // runs right before applying ops, not before verify/decrypt): an
        // envelope that fails verification or decryption must stay
        // reprocessable (e.g. on legitimate resend), not get permanently
        // blackholed by an attacker-forged or corrupted one reusing its id.
        if (seenAt.containsKey(envelope.messageId)) return

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
        seenAt[envelope.messageId] = nowMs

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
     * whole envelope is applied). Everything except YJS_UPDATE/FILE_CHUNK
     * is implemented — those two are silently ignored, matching the TS
     * engine's `default: break` (see the module doc comment for why).
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
            OperationTypes.UPDATE_OBJECT -> {
                val payload = Json.decodeFromJsonElement(UpdateObjectPayload.serializer(), op.payload)
                val existing = objects[payload.objectId]
                if (existing != null && payload.updatedAt >= existing.updatedAt) {
                    objects[payload.objectId] = existing.copy(content = payload.content, updatedAt = payload.updatedAt)
                }
            }
            OperationTypes.DELETE_OBJECT -> {
                val payload = Json.decodeFromJsonElement(ObjectRefPayload.serializer(), op.payload)
                objects.remove(payload.objectId)
            }
            OperationTypes.CONTINUE_ON_DEVICE -> {
                val payload = Json.decodeFromJsonElement(ContinueOnDevicePayload.serializer(), op.payload)
                cfg.onContinueOnDevice?.invoke(FocusRequest(payload.objectId, senderId, nowMs))
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
            OperationTypes.FILE_CHUNK -> {
                val payload = Json.decodeFromJsonElement(FileChunkPayload.serializer(), op.payload)
                val entry = incomingChunks.getOrPut(payload.fileId) { IncomingFileChunks(payload.totalChunks) }
                entry.chunks[payload.chunkIndex] = payload.dataB64
                if (payload.meta != null) entry.meta = payload.meta

                val meta = entry.meta
                if (meta != null && entry.chunks.size == entry.total) {
                    val dataB64 = StringBuilder()
                    for (i in 0 until entry.total) dataB64.append(entry.chunks[i] ?: "")
                    val fileObject = MeshObject(
                        id = payload.fileId,
                        workspaceId = op.workspaceId,
                        type = meta.objectType,
                        content = Json.encodeToJsonElement(
                            FileContent.serializer(),
                            FileContent(name = meta.name, mimeType = meta.mimeType, size = meta.size, dataB64 = dataB64.toString()),
                        ),
                        createdBy = meta.createdBy,
                        createdAt = meta.createdAt,
                        updatedAt = meta.createdAt,
                        expiresAt = meta.expiresAt,
                    )
                    if (!objects.containsKey(fileObject.id)) {
                        objects[fileObject.id] = fileObject
                        newObject = fileObject
                    }
                    incomingChunks.remove(payload.fileId)
                    recordIncomingDelivery(senderId, fileObject.id, meta.options, nowMs)
                }
            }
            OperationTypes.CARRY_BUNDLE -> {
                val payload = Json.decodeFromJsonElement(CarryBundlePayload.serializer(), op.payload)
                if (payload.destinationDeviceId != me && payload.expiresAt > nowMs && !carried.containsKey(payload.bundleId)) {
                    carried[payload.bundleId] = DeliveryBundle(
                        bundleId = payload.bundleId,
                        sourceDeviceId = payload.sourceDeviceId,
                        destinationDeviceId = payload.destinationDeviceId,
                        workspaceId = op.workspaceId,
                        encryptedPayload = fromBase64(payload.encryptedPayloadB64),
                        createdAt = payload.createdAt,
                        expiresAt = payload.expiresAt,
                        hopLimit = payload.hopLimit,
                        // The carrier can't independently verify the inner
                        // envelope's signature (it may not have that
                        // sender's key cached) — the true destination
                        // re-verifies it on arrival regardless.
                        signature = ByteArray(0),
                    )
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

        // A device just went online — that's the moment carried bundles for
        // it can be forwarded, and a moment a new carrier becomes available.
        // Routed through periodicSweep's reentrancy guard so this can't race
        // the timer-driven sweep.
        periodicSweep()
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
