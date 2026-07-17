package com.screenmesh.transport

import com.screenmesh.protocol.EnvelopeJson
import com.screenmesh.protocol.PresenceEntry
import com.screenmesh.protocol.RelayClientMessage
import com.screenmesh.protocol.RelayServerMessage
import com.screenmesh.protocol.parseRelayServerMessage
import com.screenmesh.protocol.toJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min

interface RelayAuth {
    val deviceId: String
    val workspaceId: String

    /** Signs the server's challenge nonce (UTF-8 bytes) with the device's Ed25519 key. */
    fun sign(data: ByteArray): ByteArray
}

/**
 * Kotlin mirror of packages/transport/src/websocket.ts's
 * WebSocketRelayTransport, using OkHttp instead of the browser WebSocket
 * API. The server forwards encrypted envelopes when peer-to-peer fails
 * and queues them for offline recipients; it only ever sees ciphertext.
 * Authentication: the server sends a nonce, the device returns an
 * Ed25519 signature over it. Reconnects with exponential backoff.
 *
 * `open()` blocks the calling thread until authOk (or failure) rather
 * than returning a suspend/Promise — callers must invoke it off the main
 * thread, which Android requires for networking anyway.
 */
class RelayTransport(
    private val relayWsUrl: String,
    private val auth: RelayAuth,
) : MeshTransport {
    override val kind: TransportKind = TransportKind.WEBSOCKET_RELAY

    private val client = OkHttpClient()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var status: TransportStatus = TransportStatus.IDLE
    @Volatile private var manuallyClosed = false
    @Volatile private var retryDelayMs = 1000L
    @Volatile private var retryTask: ScheduledFuture<*>? = null
    @Volatile private var presence: List<PresenceEntry> = emptyList()

    private val messageHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    private val statusHandlers = CopyOnWriteArrayList<(TransportStatus) -> Unit>()
    private val presenceHandlers = CopyOnWriteArrayList<(List<PresenceEntry>) -> Unit>()
    private val authErrorHandlers = CopyOnWriteArrayList<(String) -> Unit>()
    private val signalHandlers = CopyOnWriteArrayList<(String, JsonElement) -> Unit>()

    val isConnected: Boolean get() = status == TransportStatus.CONNECTED

    fun getPresence(): List<PresenceEntry> = presence

    /** Connect to the relay and authenticate. Blocks until authOk or failure. */
    fun open() {
        manuallyClosed = false
        dial().get(30, TimeUnit.SECONDS)
    }

    private fun dial(): CompletableFuture<Unit> {
        val future = CompletableFuture<Unit>()
        setStatus(TransportStatus.CONNECTING)
        val request = Request.Builder().url(relayWsUrl).build()
        socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleServerMessage(text, future)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handleClose(future, null)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    handleClose(future, t)
                }
            },
        )
        return future
    }

    private fun handleServerMessage(text: String, openFuture: CompletableFuture<Unit>) {
        val json = Json.parseToJsonElement(text) as? JsonObject ?: return
        when (val msg = parseRelayServerMessage(json)) {
            is RelayServerMessage.Challenge -> {
                val signature = auth.sign(msg.nonce.toByteArray(StandardCharsets.UTF_8))
                sendRaw(
                    RelayClientMessage.Auth(
                        deviceId = auth.deviceId,
                        workspaceId = auth.workspaceId,
                        signature = com.screenmesh.crypto.toBase64(signature),
                    ),
                )
            }
            is RelayServerMessage.AuthOk -> {
                retryDelayMs = 1000L
                setStatus(TransportStatus.CONNECTED)
                openFuture.complete(Unit)
            }
            is RelayServerMessage.AuthError -> {
                // The relay rejected us (revoked device, expired workspace, bad
                // key). Retrying won't help — stop reconnecting and let the app
                // decide what to do.
                manuallyClosed = true
                setStatus(TransportStatus.ERROR)
                authErrorHandlers.forEach { it(msg.reason) }
                socket?.close(1000, null)
                openFuture.completeExceptionally(Exception("relay auth failed: ${msg.reason}"))
            }
            is RelayServerMessage.EnvelopeMsg -> {
                val bytes = Json.encodeToString(EnvelopeJson.serializer(), msg.envelope)
                    .toByteArray(StandardCharsets.UTF_8)
                messageHandlers.forEach { it(bytes) }
            }
            is RelayServerMessage.Presence -> {
                presence = msg.devices
                presenceHandlers.forEach { it(msg.devices) }
            }
            is RelayServerMessage.Signal -> {
                signalHandlers.forEach { it(msg.from, msg.data) }
            }
            // Pong/Error/unrecognized: ignored, matching the TS side's default case.
            else -> Unit
        }
    }

    private fun handleClose(openFuture: CompletableFuture<Unit>, err: Throwable?) {
        socket = null
        if (status != TransportStatus.ERROR) setStatus(TransportStatus.DISCONNECTED)
        if (!manuallyClosed) scheduleReconnect()
        if (!openFuture.isDone) {
            openFuture.completeExceptionally(err ?: Exception("relay connection closed during auth"))
        }
    }

    private fun scheduleReconnect() {
        if (retryTask != null) return
        val delay = retryDelayMs
        retryDelayMs = min(retryDelayMs * 2, 30_000L)
        retryTask = scheduler.schedule(
            {
                retryTask = null
                if (!manuallyClosed) {
                    try {
                        dial()
                    } catch (_: Exception) {
                        // onClose/onFailure schedules the next retry.
                    }
                }
            },
            delay,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun setStatus(newStatus: TransportStatus) {
        if (status == newStatus) return
        status = newStatus
        statusHandlers.forEach { it(newStatus) }
    }

    private fun sendRaw(msg: RelayClientMessage) {
        val ws = socket ?: throw IllegalStateException("relay socket is not open")
        ws.send(Json.encodeToString(JsonObject.serializer(), msg.toJson()))
    }

    fun sendEnvelope(envelope: EnvelopeJson) {
        sendRaw(RelayClientMessage.EnvelopeMsg(envelope))
    }

    /**
     * Store-carry-forward: relay an envelope we did NOT create on behalf of
     * its original sender. The relay skips its usual sender-identity check
     * for this message type — see docs/Security.md.
     */
    fun forwardEnvelope(envelope: EnvelopeJson) {
        sendRaw(RelayClientMessage.Forward(envelope))
    }

    /** WebRTC signaling: send an offer/answer/ICE blob to a peer. */
    fun sendSignal(to: String, data: JsonElement) {
        sendRaw(RelayClientMessage.Signal(to, data))
    }

    /** WebRTC signaling: receive blobs from peers. Returns an unsubscriber. */
    fun subscribeSignal(handler: (String, JsonElement) -> Unit): () -> Unit {
        signalHandlers.add(handler)
        return { signalHandlers.remove(handler) }
    }

    // --- MeshTransport interface ---

    override fun discover(): List<Peer> = presence
        .filter { it.online && it.id != auth.deviceId }
        .map { Peer(deviceId = it.id, name = it.name, transport = kind) }

    override fun connect(peer: Peer): Connection {
        if (!isConnected) open()
        return Connection(peer) {}
    }

    /** Sends SecureEnvelope JSON bytes; the relay routes on the envelope header. */
    override fun send(data: ByteArray) {
        val envelope = Json.decodeFromString(EnvelopeJson.serializer(), String(data, StandardCharsets.UTF_8))
        sendEnvelope(envelope)
    }

    override fun disconnect() {
        manuallyClosed = true
        retryTask?.cancel(false)
        retryTask = null
        socket?.close(1000, null)
        socket = null
        setStatus(TransportStatus.IDLE)
    }

    override fun onMessage(handler: (ByteArray) -> Unit) {
        messageHandlers.add(handler)
    }

    override fun onStatusChange(handler: (TransportStatus) -> Unit) {
        statusHandlers.add(handler)
    }

    /** Relay-specific: presence roster updates. Returns an unsubscriber. */
    fun subscribePresence(handler: (List<PresenceEntry>) -> Unit): () -> Unit {
        presenceHandlers.add(handler)
        return { presenceHandlers.remove(handler) }
    }

    /** Fired when the relay refuses authentication (revoked / expired). */
    fun subscribeAuthError(handler: (String) -> Unit): () -> Unit {
        authErrorHandlers.add(handler)
        return { authErrorHandlers.remove(handler) }
    }
}
