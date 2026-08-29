package com.screenmesh.crypto

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Kotlin mirror of packages/crypto/src/identity.test.ts. */
class IdentityTest {
    @Test
    fun `generateIdentity gives every identity a distinct deviceId and key material`() {
        val a = generateIdentity()
        val b = generateIdentity()
        assertNotEquals(a.deviceId, b.deviceId)
        assertNotEquals(exportPublicKey(a.publicKey), exportPublicKey(b.publicKey))
    }

    @Test
    fun `verify accepts a signature from the matching identity`() {
        val identity = generateIdentity()
        val data = "hello screenmesh".toByteArray()
        val signature = sign(identity, data)
        assertTrue(verify(identity.publicKey, signature, data))
    }

    @Test
    fun `verify rejects a signature checked against a different device's public key`() {
        val identity = generateIdentity()
        val impostor = generateIdentity()
        val data = "hello screenmesh".toByteArray()
        val signature = sign(identity, data)
        assertFalse(verify(impostor.publicKey, signature, data))
    }

    @Test
    fun `verify rejects a signature when the signed data has been tampered with`() {
        val identity = generateIdentity()
        val signature = sign(identity, "original".toByteArray())
        assertFalse(verify(identity.publicKey, signature, "tampered".toByteArray()))
    }

    @Test
    fun `exportPublicKey and importPublicKey round-trip and still verify`() {
        val identity = generateIdentity()
        val reimported = importPublicKey(exportPublicKey(identity.publicKey))
        val data = "round trip check".toByteArray()
        val signature = sign(identity, data)
        assertTrue(verify(reimported, signature, data))
    }

    @Test
    fun `exportEd25519PrivateKey and importEd25519PrivateKey round-trip and can still sign`() {
        // Mirrors on-disk identity persistence — a bug here would silently
        // corrupt identity across an app relaunch (see sync/LocalState.kt).
        val identity = generateIdentity()
        val reimported = importEd25519PrivateKey(exportEd25519PrivateKey(identity.privateKey))
        val data = "persisted identity check".toByteArray()
        val signature = sign(identity.copy(privateKey = reimported), data)
        assertTrue(verify(identity.publicKey, signature, data))
    }

    @Test
    fun `exportEncryptionPublicKey and importEncryptionPrivateKey round-trip for X25519 agreement`() {
        val alice = generateIdentity()
        val bob = generateIdentity()

        val bobPubReimported = importEncryptionPublicKey(exportEncryptionPublicKey(bob.encryptionPublicKey))
        val alicePrivReimported =
            importEncryptionPrivateKey(exportEncryptionPrivateKey(alice.encryptionPrivateKey))

        // Two independent ECDH computations from reimported keys must agree —
        // this is exactly what the ratchet bootstrap depends on.
        val agreementA = run {
            val agreement = org.bouncycastle.crypto.agreement.X25519Agreement()
            agreement.init(alicePrivReimported)
            val out = ByteArray(agreement.agreementSize)
            agreement.calculateAgreement(bobPubReimported, out, 0)
            out
        }
        val agreementB = run {
            val agreement = org.bouncycastle.crypto.agreement.X25519Agreement()
            agreement.init(bob.encryptionPrivateKey)
            val out = ByteArray(agreement.agreementSize)
            agreement.calculateAgreement(alice.encryptionPublicKey, out, 0)
            out
        }
        org.junit.Assert.assertArrayEquals(agreementA, agreementB)
    }
}
