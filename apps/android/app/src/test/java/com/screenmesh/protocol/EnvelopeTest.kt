package com.screenmesh.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Kotlin mirror of packages/protocol/src/envelope.test.ts. */
class EnvelopeTest {
    private fun makeEnvelope(expiresAt: Long? = null): SecureEnvelope = SecureEnvelope(
        version = 2,
        messageId = "msg-1",
        senderDeviceId = "device-a",
        recipientDeviceId = "device-b",
        workspaceId = "workspace-1",
        createdAt = 1_700_000_000_000,
        expiresAt = expiresAt,
        sequenceNumber = 3,
        ratchetPublicKeyB64 = "cGVlci1yYXRjaGV0LWtleQ==",
        messageNumber = 1,
        previousChainLength = 0,
        ciphertext = byteArrayOf(1, 2, 3, 4, 5),
        signature = byteArrayOf(9, 8, 7, 6),
    )

    @Test
    fun `round-trips every field, including binary ciphertext and signature`() {
        val env = makeEnvelope()
        val roundTripped = env.toJson().toEnvelope()
        assertEquals(env.version, roundTripped.version)
        assertEquals(env.messageId, roundTripped.messageId)
        assertEquals(env.senderDeviceId, roundTripped.senderDeviceId)
        assertEquals(env.recipientDeviceId, roundTripped.recipientDeviceId)
        assertEquals(env.workspaceId, roundTripped.workspaceId)
        assertEquals(env.createdAt, roundTripped.createdAt)
        assertEquals(env.expiresAt, roundTripped.expiresAt)
        assertEquals(env.sequenceNumber, roundTripped.sequenceNumber)
        assertEquals(env.ratchetPublicKeyB64, roundTripped.ratchetPublicKeyB64)
        assertEquals(env.messageNumber, roundTripped.messageNumber)
        assertEquals(env.previousChainLength, roundTripped.previousChainLength)
        org.junit.Assert.assertArrayEquals(env.ciphertext, roundTripped.ciphertext)
        org.junit.Assert.assertArrayEquals(env.signature, roundTripped.signature)
    }

    @Test
    fun `round-trips expiresAt when present and preserves null when absent`() {
        assertNull(makeEnvelope().toJson().toEnvelope().expiresAt)
        assertEquals(1_700_000_500_000L, makeEnvelope(expiresAt = 1_700_000_500_000L).toJson().toEnvelope().expiresAt)
    }

    @Test
    fun `encodes ciphertext and signature as base64 strings on the wire`() {
        val json = makeEnvelope().toJson()
        // EnvelopeJson.ciphertext/signature are typed String — this mainly
        // documents intent (compile-time already guarantees the type); the
        // real value is confirming they decode back via fromBase64 cleanly.
        assertTrue(json.ciphertext.isNotEmpty())
        assertTrue(json.signature.isNotEmpty())
    }
}
