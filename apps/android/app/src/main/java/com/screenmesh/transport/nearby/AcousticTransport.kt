package com.screenmesh.transport.nearby

import android.content.Context
import com.dweekly.cyrinxhil.AndroidAudioBackend
import com.dweekly.cyrinxhil.CyrinxTransportSession
import com.dweekly.cyrinxhil.QoS
import com.dweekly.cyrinxhil.Role
import com.dweekly.cyrinxhil.SessionConfig
import com.screenmesh.transport.Connection
import com.screenmesh.transport.MeshTransport
import com.screenmesh.transport.Peer
import com.screenmesh.transport.TransportKind
import com.screenmesh.transport.TransportStatus
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** ScreenMesh's fixed logical stream for envelope traffic — must be in (STREAM_CONTROL, STREAM_ID_MAX]. */
private const val ENVELOPE_STREAM_ID = 1

/** How long each receive() poll blocks before checking `running` again. */
private const val RECEIVE_POLL_MS = 200L

/**
 * Acoustic (near-ultrasonic, ~18.5-21 kHz) data transport over the phone's
 * own speaker and microphone — no Bluetooth/Wi-Fi/NFC radio at all, just
 * sound. Wraps the vendored `com.dweekly.cyrinxhil` classes (see that
 * package's `NOTICE.md`) rather than reimplementing OFDM/D-CSS modulation,
 * preamble sync, or channel estimation from scratch.
 *
 * **Fundamentally different shape from BLE/Wi-Fi Direct**: Cyrinx has no
 * multi-peer discovery or addressing — it's a single half-duplex
 * point-to-point link with whichever device is close enough to hear, so
 * one side must start as [Role.MASTER] (initiates) and the other as
 * [Role.SLAVE] (responds); there's no auto-negotiation. [discover] can
 * only ever report "linked" or "not linked", never a list of candidates.
 *
 * **Real, measured throughput/reliability limits worth knowing before
 * using this for anything beyond a short control message**: upstream's
 * own README describes this Kotlin/Swift "gears, ARQ, crypto envelope"
 * ultrasonic stack (as opposed to the separate, much faster Swift-only
 * wideband bulk PHY this module does NOT vendor) as measured at
 * **under 0.3 kbps over the air** — call it tens of bytes per second in
 * the worst case. [send] also hard-caps a single logical message at
 * `CyrinxConstants.MAX_LOGICAL_MESSAGE` = 4096 bytes (returns silently
 * without sending anything larger — see the doc comment on [send]).
 * This is a transport for a pairing code or a short text note within
 * arm's reach of a working mic/speaker, not for files or even
 * moderately-sized objects.
 *
 * `enableCrypto` is deliberately left `false`: every byte this transport
 * ever carries is already a ScreenMesh `SecureEnvelope` — encrypted,
 * signed, and verified by `MeshEngine`/`crypto/SecureEnvelopeCodec.kt`
 * one layer up. Turning on Cyrinx's own optional end-to-end envelope
 * underneath would add a second, independent crypto scheme with no
 * additional security benefit, and would make wire-format debugging
 * harder by mixing two trust boundaries.
 *
 * UNTESTED: this compiles as part of the normal Android Gradle build
 * (pure Kotlin + `android.media.AudioRecord`/`AudioTrack`, no native/JNI
 * step), but the acoustic link itself has never been exercised over real
 * air on real hardware in the environment this was written in — see
 * docs/Android.md.
 */
class AcousticTransport(private val context: Context) : MeshTransport {
    override val kind: TransportKind = TransportKind.ACOUSTIC

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)

    private var session: CyrinxTransportSession? = null
    private var backend: AndroidAudioBackend? = null

    private val messageHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    private val statusHandlers = CopyOnWriteArrayList<(TransportStatus) -> Unit>()

    private var status: TransportStatus = TransportStatus.IDLE
        set(value) {
            if (field == value) return
            field = value
            statusHandlers.forEach { it(value) }
        }

    /**
     * Starts the acoustic link as either the initiator ([Role.MASTER]) or
     * responder ([Role.SLAVE]) — see the class doc comment on why the
     * caller, not this class, must decide which. Requires
     * `android.permission.RECORD_AUDIO`, already granted, before calling
     * (this class does not request permissions itself, matching
     * `BleTransport`/`WifiDirectTransport`).
     */
    fun start(role: Role) {
        if (running.getAndSet(true)) return
        status = TransportStatus.DISCOVERING

        val config = SessionConfig(role = role, enableCrypto = false)
        lateinit var newSession: CyrinxTransportSession
        val newBackend = AndroidAudioBackend(
            context = context,
            config = config,
            frameIngress = { frame, report -> newSession.ingestFrame(frame, report) },
        )
        newSession = CyrinxTransportSession(config = config, txSink = newBackend)
        session = newSession
        backend = newBackend

        newBackend.start()
        newSession.start()
        status = TransportStatus.CONNECTED

        executor.execute {
            while (running.get()) {
                val message = newSession.receive(RECEIVE_POLL_MS)
                if (message != null) {
                    messageHandlers.forEach { it(message.data) }
                }
            }
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        session?.stop()
        backend?.stop()
        session = null
        backend = null
        status = TransportStatus.IDLE
    }

    // --- MeshTransport ---

    /** Never a real candidate list — see the class doc comment. Reports the current peer once linked, nothing otherwise. */
    override fun discover(): List<Peer> {
        val activeSession = session ?: return emptyList()
        if (status != TransportStatus.CONNECTED) return emptyList()
        return listOf(Peer(deviceId = "acoustic-${activeSession.peerDeviceSignature}", name = "Acoustic peer", transport = kind))
    }

    override fun connect(peer: Peer): Connection = Connection(peer) {}

    /**
     * Sends over the single active acoustic link, if any. Blocks the
     * calling thread — `CyrinxTransportSession.send` busy-waits for an ACK
     * (reliable QoS, up to several seconds across retries) — callers must
     * invoke this off the main thread, same as every other blocking call
     * in this codebase. Silently drops (returns without sending) anything
     * over 4096 bytes or if no link is currently up — `MeshTransport.send`
     * has no failure-reporting channel, matching every other transport
     * here. A non-OK return (bad argument, not-yet-started, or an ACK
     * timeout on a reliable send) is deliberately NOT treated as a link
     * failure here — an oversized payload, for instance, says nothing
     * about whether the link itself is still healthy — so `status` is
     * left alone; only `start`/`stop` change it.
     */
    override fun send(data: ByteArray) {
        val activeSession = session ?: return
        activeSession.send(data, streamId = ENVELOPE_STREAM_ID, qos = QoS.RELIABLE)
    }

    override fun disconnect() = stop()

    override fun onMessage(handler: (ByteArray) -> Unit) {
        messageHandlers.add(handler)
    }

    override fun onStatusChange(handler: (TransportStatus) -> Unit) {
        statusHandlers.add(handler)
    }
}
