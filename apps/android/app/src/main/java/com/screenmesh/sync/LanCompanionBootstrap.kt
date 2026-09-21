package com.screenmesh.sync

import com.screenmesh.crypto.fromBase64
import com.screenmesh.crypto.toBase64
import com.screenmesh.protocol.LanPairingEndpoint
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/** One QR-pinned TLS socket to the local companion. It moves only envelope bytes. */
class LanCompanionDirect(
    private val socket: SSLSocket,
    private val peerDeviceId: String,
    private val reader: BufferedReader,
    private val writer: BufferedWriter,
) : DirectChannel {
    private val handlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    @Volatile private var open = true

    init {
        thread(name = "screenmesh-lan-reader", isDaemon = true) {
            try {
                while (open) {
                    val frame = JSONObject(reader.readLine() ?: break)
                    if (frame.optString("type") != "screenmesh.lan.envelope") break
                    val bytes = fromBase64(frame.optString("envelopeB64"))
                    if (bytes.isEmpty() || bytes.size > 1024 * 1024) break
                    handlers.forEach { it(bytes) }
                }
            } catch (_: Exception) {
                // A broken LAN route is expected; MeshEngine falls back to relay.
            } finally {
                open = false
                runCatching { socket.close() }
            }
        }
    }

    override fun trySend(peerId: String, data: ByteArray): Boolean {
        if (!open || peerId != peerDeviceId || data.isEmpty() || data.size > 1024 * 1024) return false
        return try {
            synchronized(writer) {
                writer.write(JSONObject().put("type", "screenmesh.lan.envelope").put("envelopeB64", toBase64(data)).toString())
                writer.newLine()
                writer.flush()
            }
            true
        } catch (_: Exception) {
            open = false
            false
        }
    }

    override fun onMessage(handler: (ByteArray) -> Unit) { handlers.add(handler) }
    override fun close() { open = false; runCatching { socket.close() } }
}

/** Validates the SM2 certificate SPKI pin before sending the one-use token. */
fun verifyLanCompanionBootstrap(endpoint: LanPairingEndpoint, deviceId: String, peerDeviceId: String): LanCompanionDirect {
    val expectedPin = endpoint.certificateSha256.removePrefix("sha256/")
        .takeIf { endpoint.certificateSha256.startsWith("sha256/") }
        ?.let(::fromBase64)
        ?: throw IllegalArgumentException("invalid LAN certificate pin")
    require(expectedPin.size == 32) { "invalid LAN certificate pin" }
    val pinTrustOnly = object : X509TrustManager {
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    }
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf<TrustManager>(pinTrustOnly), null)
    val socket = context.socketFactory.createSocket(endpoint.address, endpoint.port) as SSLSocket
    try {
        socket.soTimeout = 10_000
        val protocols = listOf("TLSv1.3", "TLSv1.2").filter { it in socket.supportedProtocols }.toTypedArray()
        if (protocols.isEmpty()) throw IllegalStateException("device has no supported secure TLS protocol")
        socket.enabledProtocols = protocols
        socket.startHandshake()
        val certificate = socket.session.peerCertificates.firstOrNull() as? X509Certificate
            ?: throw IllegalStateException("LAN listener did not present a certificate")
        val actualPin = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
        if (!MessageDigest.isEqual(expectedPin, actualPin)) throw SecurityException("LAN listener certificate pin mismatch")
        val writer = BufferedWriter(OutputStreamWriter(socket.outputStream, Charsets.UTF_8))
        val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
        writer.write(JSONObject().put("type", "screenmesh.lan.hello").put("sessionToken", endpoint.sessionToken).put("deviceId", deviceId).toString())
        writer.newLine()
        writer.flush()
        val ready = JSONObject(reader.readLine() ?: throw IllegalStateException("LAN listener closed the pairing handshake"))
        if (ready.optString("type") != "screenmesh.lan.ready" || ready.optString("sessionId") != endpoint.sessionId) {
            throw SecurityException("LAN listener rejected the pairing handshake")
        }
        socket.soTimeout = 0
        return LanCompanionDirect(socket, peerDeviceId, reader, writer)
    } catch (error: Exception) {
        runCatching { socket.close() }
        throw error
    }
}
