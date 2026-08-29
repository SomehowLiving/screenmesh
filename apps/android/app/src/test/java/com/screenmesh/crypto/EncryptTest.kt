package com.screenmesh.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** Kotlin mirror of packages/crypto/src/encrypt.test.ts. */
class EncryptTest {
    @Test
    fun `encrypt and decrypt round-trip plaintext`() {
        val key = generateWorkspaceKey()
        val plaintext = "a secret handoff payload".toByteArray()
        val payload = encrypt(key, plaintext)
        assertArrayEquals(plaintext, decrypt(key, payload))
    }

    @Test
    fun `encrypt uses a fresh nonce per call`() {
        val key = generateWorkspaceKey()
        val plaintext = "same plaintext twice".toByteArray()
        val a = encrypt(key, plaintext)
        val b = encrypt(key, plaintext)
        assertNotEquals(java.util.Base64.getEncoder().encodeToString(a.nonce), java.util.Base64.getEncoder().encodeToString(b.nonce))
        assertNotEquals(
            java.util.Base64.getEncoder().encodeToString(a.ciphertext),
            java.util.Base64.getEncoder().encodeToString(b.ciphertext),
        )
    }

    @Test
    fun `nonce is NONCE_BYTES long`() {
        val key = generateWorkspaceKey()
        val payload = encrypt(key, byteArrayOf(1, 2, 3))
        assertEquals(NONCE_BYTES, payload.nonce.size)
    }

    @Test(expected = Exception::class)
    fun `decrypt fails with the wrong key`() {
        val key = generateWorkspaceKey()
        val wrongKey = generateWorkspaceKey()
        val payload = encrypt(key, "secret".toByteArray())
        decrypt(wrongKey, payload)
    }

    @Test(expected = Exception::class)
    fun `decrypt fails if the ciphertext is tampered with`() {
        val key = generateWorkspaceKey()
        val payload = encrypt(key, "secret".toByteArray())
        val tampered = payload.ciphertext.copyOf()
        tampered[0] = (tampered[0].toInt() xor 0xff).toByte()
        decrypt(key, EncryptedPayload(payload.nonce, tampered))
    }

    @Test(expected = Exception::class)
    fun `decrypt fails if the nonce is wrong`() {
        val key = generateWorkspaceKey()
        val payload = encrypt(key, "secret".toByteArray())
        val wrongNonce = payload.nonce.copyOf()
        wrongNonce[0] = (wrongNonce[0].toInt() xor 0xff).toByte()
        decrypt(key, EncryptedPayload(wrongNonce, payload.ciphertext))
    }

    @Test
    fun `exportWorkspaceKey and importWorkspaceKey round-trip and still decrypt`() {
        val key = generateWorkspaceKey()
        val reimported = importWorkspaceKey(exportWorkspaceKey(key))
        val plaintext = "shared over the QR channel".toByteArray()
        val payload = encrypt(key, plaintext)
        assertArrayEquals(plaintext, decrypt(reimported, payload))
    }
}
