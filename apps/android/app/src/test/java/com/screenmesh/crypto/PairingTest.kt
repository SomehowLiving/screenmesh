package com.screenmesh.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

/** Kotlin mirror of packages/crypto/src/pairing.test.ts. */
class PairingTest {
    @Test
    fun `randomId produces distinct, URL-safe identifiers`() {
        val a = randomId()
        val b = randomId()
        assertNotEquals(a, b)
        assertFalse(a.contains(Regex("[+/=]")))
    }

    @Test
    fun `round-trips a payload through the compact SM1 wire format`() {
        val workspaceKey = toBase64(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val now = 1_700_000_000_000L
        val payload = createPairingPayload(workspaceId = "ws-1", workspaceKey = workspaceKey, now = now)

        val encoded = encodePairingPayload(payload)
        assertTrue(encoded.startsWith("SM1."))

        val decoded = decodePairingPayload(encoded)
        // serverUrl is not on the wire (see below), so it's expected to differ (null) here.
        assertEquals(payload.copy(serverUrl = null), decoded)
    }

    @Test
    fun `does not encode serverUrl into the wire format`() {
        val workspaceKey = toBase64(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val payload = createPairingPayload(
            workspaceId = "ws-1",
            workspaceKey = workspaceKey,
            now = System.currentTimeMillis(),
            serverUrl = "https://example.test",
        )
        val encoded = encodePairingPayload(payload)
        assertFalse(encoded.contains("example.test"))
        assertNull(decodePairingPayload(encoded).serverUrl)
    }

    @Test
    fun `applies the default 5-minute TTL when none is given`() {
        val now = 1_700_000_000_000L
        val payload = createPairingPayload(workspaceId = "ws-1", workspaceKey = "a2V5", now = now)
        assertEquals(now + 5 * 60 * 1000L, payload.expiresAt)
    }

    @Test
    fun `honors an explicit ttlMs`() {
        val now = 1_700_000_000_000L
        val payload = createPairingPayload(workspaceId = "ws-1", workspaceKey = "a2V5", now = now, ttlMs = 30_000)
        assertEquals(now + 30_000, payload.expiresAt)
    }

    @Test
    fun `round-trips a workspaceKey containing plus, slash, and padding-sensitive lengths`() {
        for (byteLength in listOf(15, 16, 17, 32)) {
            val workspaceKey = toBase64(ByteArray(byteLength) { ((it * 37) % 256).toByte() })
            val payload = createPairingPayload(
                workspaceId = "ws-1",
                workspaceKey = workspaceKey,
                now = System.currentTimeMillis(),
            )
            val decoded = decodePairingPayload(encodePairingPayload(payload))
            assertEquals(workspaceKey, decoded.workspaceKey)
        }
    }

    @Test
    fun `rejects a code with the wrong prefix`() {
        assertThrows(IllegalArgumentException::class.java) {
            decodePairingPayload("XX2.ws.tok.a2V5.1")
        }
    }

    @Test
    fun `rejects a code with the wrong number of segments`() {
        assertThrows(IllegalArgumentException::class.java) {
            decodePairingPayload("SM1.ws.tok.a2V5")
        }
    }

    @Test
    fun `rejects a code with an empty required segment`() {
        assertThrows(IllegalArgumentException::class.java) {
            decodePairingPayload("SM1..tok.a2V5.1")
        }
    }

    @Test
    fun `isPairingExpired is false strictly before expiresAt and true at or after it`() {
        val payload = createPairingPayload(workspaceId = "ws-1", workspaceKey = "a2V5", now = 1000)
        assertFalse(isPairingExpired(payload, payload.expiresAt - 1))
        assertTrue(isPairingExpired(payload, payload.expiresAt))
        assertTrue(isPairingExpired(payload, payload.expiresAt + 1))
    }
}
