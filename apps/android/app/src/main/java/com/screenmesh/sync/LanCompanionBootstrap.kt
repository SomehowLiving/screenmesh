package com.screenmesh.sync

import com.screenmesh.crypto.fromBase64
import com.screenmesh.protocol.LanPairingEndpoint
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Validates the temporary LAN listener advertised in an SM2 QR. The QR's SPKI
 * digest is the trust anchor; accepting the self-signed certificate before
 * comparing that exact pin does not grant it trust. No pairing secret or
 * ScreenMesh plaintext crosses this socket.
 */
fun verifyLanCompanionBootstrap(endpoint: LanPairingEndpoint) {
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
    (context.socketFactory.createSocket(endpoint.address, endpoint.port) as SSLSocket).use { socket ->
        socket.soTimeout = 10_000
        val secureProtocols = listOf("TLSv1.3", "TLSv1.2").filter { it in socket.supportedProtocols }.toTypedArray()
        if (secureProtocols.isEmpty()) throw IllegalStateException("device has no supported secure TLS protocol")
        socket.enabledProtocols = secureProtocols
        socket.startHandshake()
        val certificate = socket.session.peerCertificates.firstOrNull() as? X509Certificate
            ?: throw IllegalStateException("LAN listener did not present a certificate")
        val actualPin = MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)
        if (!MessageDigest.isEqual(expectedPin, actualPin)) throw SecurityException("LAN listener certificate pin mismatch")

        BufferedWriter(OutputStreamWriter(socket.outputStream, Charsets.UTF_8)).use { writer ->
            writer.write(JSONObject().put("type", "screenmesh.lan.hello").put("sessionToken", endpoint.sessionToken).toString())
            writer.newLine()
            writer.flush()
            val response = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8)).readLine()
                ?: throw IllegalStateException("LAN listener closed the pairing handshake")
            val ready = JSONObject(response)
            if (ready.optString("type") != "screenmesh.lan.ready" || ready.optString("sessionId") != endpoint.sessionId) {
                throw SecurityException("LAN listener rejected the pairing handshake")
            }
        }
    }
}
