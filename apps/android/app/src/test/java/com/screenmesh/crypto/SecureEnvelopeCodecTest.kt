package com.screenmesh.crypto

import com.screenmesh.protocol.SecureEnvelope
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.security.SecureRandom

private const val WORKSPACE_ID = "workspace-1"

private data class Ctx(
    val alice: DeviceIdentity,
    val bob: DeviceIdentity,
    val aliceSession: RatchetSession,
    val bobSession: RatchetSession,
)

private fun bootstrap(): Ctx {
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
    return Ctx(alice, bob, aliceSession, bobSession)
}

private fun sealFromAlice(
    ctx: Ctx,
    plaintext: String,
    createdAt: Long = System.currentTimeMillis(),
    expiresAt: Long? = null,
): SecureEnvelope {
    val (messageKey, header) = ratchetEncrypt(ctx.aliceSession)
    return sealEnvelope(
        SealParams(
            identity = ctx.alice,
            recipientDeviceId = ctx.bob.deviceId,
            workspaceId = WORKSPACE_ID,
            messageKey = messageKey,
            ratchetHeader = header,
            plaintext = plaintext.toByteArray(),
            sequenceNumber = 0,
            createdAt = createdAt,
            expiresAt = expiresAt,
        ),
    )
}

private fun receiveAsBob(ctx: Ctx, env: SecureEnvelope): ByteArray {
    val messageKey = ratchetDecrypt(
        ctx.bobSession,
        RatchetMessageHeader(env.ratchetPublicKeyB64, env.messageNumber, env.previousChainLength),
    )
    return decryptEnvelope(env, messageKey)
}

/** Kotlin mirror of packages/crypto/src/envelope.test.ts. */
class SecureEnvelopeCodecTest {
    private lateinit var ctx: Ctx

    @Before
    fun setUp() {
        ctx = bootstrap()
    }

    @Test
    fun `round-trips plaintext through the real seal to verify to ratchet-decrypt to decrypt path`() {
        val env = sealFromAlice(ctx, "hello bob")
        verifyEnvelope(env, ctx.alice.publicKey, System.currentTimeMillis())
        val plaintext = receiveAsBob(ctx, env)
        assertArrayEquals("hello bob".toByteArray(), plaintext)
    }

    @Test
    fun `fails verification if the ciphertext is tampered with`() {
        val env = sealFromAlice(ctx, "hello bob")
        val tampered = env.copy(ciphertext = env.ciphertext.copyOf())
        tampered.ciphertext[0] = (tampered.ciphertext[0].toInt() xor 0xff).toByte()
        assertThrows(Exception::class.java) { verifyEnvelope(tampered, ctx.alice.publicKey, System.currentTimeMillis()) }
    }

    @Test
    fun `fails verification if the signature is tampered with`() {
        val env = sealFromAlice(ctx, "hello bob")
        val tampered = env.copy(signature = env.signature.copyOf())
        tampered.signature[0] = (tampered.signature[0].toInt() xor 0xff).toByte()
        assertThrows(Exception::class.java) { verifyEnvelope(tampered, ctx.alice.publicKey, System.currentTimeMillis()) }
    }

    @Test
    fun `fails verification if a field outside the signed set is swapped`() {
        val env = sealFromAlice(ctx, "hello bob")
        val redirected = env.copy(recipientDeviceId = "some-other-device")
        assertThrows(Exception::class.java) {
            verifyEnvelope(redirected, ctx.alice.publicKey, System.currentTimeMillis())
        }
    }

    @Test
    fun `fails verification if checked against the wrong sender's public key`() {
        val impostor = generateIdentity()
        val env = sealFromAlice(ctx, "hello bob")
        assertThrows(Exception::class.java) { verifyEnvelope(env, impostor.publicKey, System.currentTimeMillis()) }
    }

    @Test
    fun `fails verification on an expired envelope even with a valid signature`() {
        val now = System.currentTimeMillis()
        val env = sealFromAlice(ctx, "hello bob", createdAt = now - 1000, expiresAt = now - 500)
        assertThrows(Exception::class.java) { verifyEnvelope(env, ctx.alice.publicKey, now) }
    }

    @Test
    fun `does not throw on expiry when checked before expiresAt`() {
        val now = System.currentTimeMillis()
        val env = sealFromAlice(ctx, "hello bob", createdAt = now, expiresAt = now + 60_000)
        verifyEnvelope(env, ctx.alice.publicKey, now) // must not throw
    }
}
