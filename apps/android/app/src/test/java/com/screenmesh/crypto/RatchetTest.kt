package com.screenmesh.crypto

import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val WORKSPACE_ID = "workspace-1"
private val TEST_NONCE = ByteArray(12) // fixed nonce: fine for single-use test keys, never reused per key here.

private fun aesEncrypt(key: SecretKey, plaintext: String): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, TEST_NONCE))
    return cipher.doFinal(plaintext.toByteArray())
}

private fun aesDecrypt(key: SecretKey, ciphertext: ByteArray): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, TEST_NONCE))
    return String(cipher.doFinal(ciphertext))
}

private data class SessionPair(
    val alice: DeviceIdentity,
    val bob: DeviceIdentity,
    val aliceSession: RatchetSession,
    val bobSession: RatchetSession,
)

private fun bootstrapSessionPair(): SessionPair {
    val alice = generateIdentity()
    val bob = generateIdentity()
    val pairingSecret = ByteArray(32).also { SecureRandom().nextBytes(it) }

    val aliceSession = initRatchetSession(
        workspaceId = WORKSPACE_ID,
        myDeviceId = alice.deviceId,
        myIdentityPublic = alice.encryptionPublicKey,
        myIdentityPrivate = alice.encryptionPrivateKey,
        peerDeviceId = bob.deviceId,
        peerIdentityPublic = bob.encryptionPublicKey,
        pairingSecret = pairingSecret,
    )
    val bobSession = initRatchetSession(
        workspaceId = WORKSPACE_ID,
        myDeviceId = bob.deviceId,
        myIdentityPublic = bob.encryptionPublicKey,
        myIdentityPrivate = bob.encryptionPrivateKey,
        peerDeviceId = alice.deviceId,
        peerIdentityPublic = alice.encryptionPublicKey,
        pairingSecret = pairingSecret,
    )
    return SessionPair(alice, bob, aliceSession, bobSession)
}

private data class Delivery(val header: RatchetMessageHeader, val decrypted: String)

private fun sendAndDeliver(sender: RatchetSession, receiver: RatchetSession, plaintext: String): Delivery {
    val (messageKey, header) = ratchetEncrypt(sender)
    val ciphertext = aesEncrypt(messageKey, plaintext)
    val recvKey = ratchetDecrypt(receiver, header)
    return Delivery(header, aesDecrypt(recvKey, ciphertext))
}

/** Kotlin mirror of packages/crypto/src/ratchet.test.ts. */
class RatchetTest {
    private lateinit var pair: SessionPair

    @Before
    fun setUp() {
        pair = bootstrapSessionPair()
    }

    @Test
    fun `both sides derive the same root key at bootstrap`() {
        assertArrayEquals(pair.aliceSession.rootKey, pair.bobSession.rootKey)
    }

    @Test
    fun `delivers Alice's first message to Bob correctly (identity-keyed, pre-heal)`() {
        val delivery = sendAndDeliver(pair.aliceSession, pair.bobSession, "hello bob")
        assertEquals("hello bob", delivery.decrypted)
    }

    @Test
    fun `heals after one round trip - both directions work once each side has sent`() {
        fun rawPub(key: X25519PublicKeyParameters) = key.encoded
        val aliceBefore = rawPub(pair.aliceSession.myRatchetKeyPair.publicKey)
        val bobBefore = rawPub(pair.bobSession.myRatchetKeyPair.publicKey)

        sendAndDeliver(pair.aliceSession, pair.bobSession, "hi from alice")
        val reply = sendAndDeliver(pair.bobSession, pair.aliceSession, "hi from bob")
        assertEquals("hi from bob", reply.decrypted)

        assertNotEquals(
            java.util.Base64.getEncoder().encodeToString(aliceBefore),
            java.util.Base64.getEncoder().encodeToString(rawPub(pair.aliceSession.myRatchetKeyPair.publicKey)),
        )
        assertNotEquals(
            java.util.Base64.getEncoder().encodeToString(bobBefore),
            java.util.Base64.getEncoder().encodeToString(rawPub(pair.bobSession.myRatchetKeyPair.publicKey)),
        )

        val again = sendAndDeliver(pair.aliceSession, pair.bobSession, "second message")
        assertEquals("second message", again.decrypted)
        val againReply = sendAndDeliver(pair.bobSession, pair.aliceSession, "second reply")
        assertEquals("second reply", againReply.decrypted)
    }

    @Test
    fun `tolerates out-of-order delivery via the skipped-key cache`() {
        val sent = (0 until 3).map { i ->
            val (messageKey, header) = ratchetEncrypt(pair.aliceSession)
            header to aesEncrypt(messageKey, "msg-$i")
        }

        // Arrival order: 2, 0, 1.
        val key2 = ratchetDecrypt(pair.bobSession, sent[2].first)
        assertEquals("msg-2", aesDecrypt(key2, sent[2].second))

        val key0 = ratchetDecrypt(pair.bobSession, sent[0].first)
        assertEquals("msg-0", aesDecrypt(key0, sent[0].second))

        val key1 = ratchetDecrypt(pair.bobSession, sent[1].first)
        assertEquals("msg-1", aesDecrypt(key1, sent[1].second))
    }

    @Test
    fun `refuses to re-derive a message key for an already-consumed message number`() {
        val delivery = sendAndDeliver(pair.aliceSession, pair.bobSession, "only once")
        assertThrows(RatchetError::class.java) { ratchetDecrypt(pair.bobSession, delivery.header) }
    }

    @Test
    fun `refuses to re-derive a message key for an already-consumed skipped message (replay)`() {
        val sent = (0 until 2).map { i ->
            val (messageKey, header) = ratchetEncrypt(pair.aliceSession)
            header to aesEncrypt(messageKey, "msg-$i")
        }
        ratchetDecrypt(pair.bobSession, sent[1].first)
        ratchetDecrypt(pair.bobSession, sent[0].first)
        assertThrows(RatchetError::class.java) { ratchetDecrypt(pair.bobSession, sent[0].first) }
    }
}
