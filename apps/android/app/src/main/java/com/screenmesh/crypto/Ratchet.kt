package com.screenmesh.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.generators.X25519KeyPairGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519KeyGenerationParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * Kotlin mirror of packages/crypto/src/ratchet.ts — a simplified Double
 * Ratchet (Signal-style) session between exactly two devices, giving each
 * envelope its own single-use encryption key. See the TS file's module
 * doc comment (and docs/Security.md §5) for the full design rationale,
 * including the deliberate X3DH-lite bootstrap — both sides seed
 * `myRatchetKeyPair` with their OWN identity keypair so either can send
 * first, the session "heals" to fresh ephemeral keys after one round
 * trip — and the capped skipped-message-key tolerance
 * (MAX_SKIPPED_KEYS/MAX_SKIP_PER_STEP).
 *
 * RatchetSession is a mutable class, not an immutable data class the TS
 * side reassigns fields on: since it's a plain reference type, mutating
 * it in place IS persisting it for any caller holding the same reference
 * — there's no separate "save the returned session" step needed here.
 */

private const val HKDF_INFO_ROOT = "screenmesh-ratchet-root-v1"
private const val HKDF_INFO_DH = "screenmesh-ratchet-dh-v1"
private const val MAX_SKIPPED_KEYS = 50
private const val MAX_SKIP_PER_STEP = 500

class RatchetError(message: String) : Exception(message)

data class RatchetKeyPair(
    val publicKey: X25519PublicKeyParameters,
    val privateKey: X25519PrivateKeyParameters,
)

private data class SkippedKey(
    val ratchetPublicKeyB64: String,
    val messageNumber: Int,
    val messageKeyB64: String,
)

data class RatchetMessageHeader(
    val ratchetPublicKeyB64: String,
    val messageNumber: Int,
    val previousChainLength: Int,
)

class RatchetSession(
    var rootKey: ByteArray,
    /** My current DH ratchet keypair — starts as my identity keypair, then
     *  becomes fresh ephemeral material the first time I have to respond
     *  to the peer's ratchet key changing. */
    var myRatchetKeyPair: RatchetKeyPair,
    /** The peer's most recently observed ratchet public key. */
    var theirRatchetPublicKeyB64: String,
    var sendChainKey: ByteArray?,
    var recvChainKey: ByteArray?,
    var sendMessageNumber: Int,
    var recvMessageNumber: Int,
    var previousSendChainLength: Int,
) {
    internal val skippedKeys: MutableList<SkippedKey> = mutableListOf()
}

// --- primitives ---

private fun ecdhBits(myPrivate: X25519PrivateKeyParameters, theirPublic: X25519PublicKeyParameters): ByteArray {
    val agreement = X25519Agreement()
    agreement.init(myPrivate)
    val out = ByteArray(agreement.agreementSize)
    agreement.calculateAgreement(theirPublic, out, 0)
    return out
}

private fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, lengthBytes: Int): ByteArray {
    val generator = HKDFBytesGenerator(SHA256Digest())
    generator.init(HKDFParameters(ikm, salt, info.toByteArray(Charsets.UTF_8)))
    val out = ByteArray(lengthBytes)
    generator.generateBytes(out, 0, lengthBytes)
    return out
}

private fun hmacSha256(keyBytes: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
    return mac.doFinal(data)
}

/** One step of the symmetric-key ratchet: derive a message key, advance the chain. */
private fun stepChain(chainKey: ByteArray): Pair<ByteArray, ByteArray> {
    val messageKey = hmacSha256(chainKey, byteArrayOf(0x01))
    val nextChainKey = hmacSha256(chainKey, byteArrayOf(0x02))
    return messageKey to nextChainKey
}

private fun importAesKey(bytes: ByteArray): SecretKey = SecretKeySpec(bytes, "AES")

fun generateRatchetKeyPair(): RatchetKeyPair {
    val gen = X25519KeyPairGenerator()
    gen.init(X25519KeyGenerationParameters(SecureRandom()))
    val pair = gen.generateKeyPair()
    return RatchetKeyPair(
        publicKey = pair.public as X25519PublicKeyParameters,
        privateKey = pair.private as X25519PrivateKeyParameters,
    )
}

private fun exportRatchetPublicKey(key: X25519PublicKeyParameters): String = toBase64(key.encoded)

private fun importRatchetPublicKey(b64: String): X25519PublicKeyParameters =
    X25519PublicKeyParameters(fromBase64(b64), 0)

/**
 * Bootstrap a brand-new session with a peer. Both sides compute this with
 * the same sorted inputs and arrive at the same root key. `myRatchetKeyPair`
 * starts as MY OWN identity keypair (not a fresh ephemeral one) so either
 * side can send first without having received anything yet.
 */
fun initRatchetSession(
    workspaceId: String,
    myDeviceId: String,
    myIdentityPublic: X25519PublicKeyParameters,
    myIdentityPrivate: X25519PrivateKeyParameters,
    peerDeviceId: String,
    peerIdentityPublic: X25519PublicKeyParameters,
    pairingSecret: ByteArray,
): RatchetSession {
    val ecdh = ecdhBits(myIdentityPrivate, peerIdentityPublic)
    val sorted = listOf(myDeviceId, peerDeviceId).sorted()
    val info = "$HKDF_INFO_ROOT|$workspaceId|${sorted[0]}|${sorted[1]}"
    val rootKey = hkdf(ecdh, pairingSecret, info, 32)
    return RatchetSession(
        rootKey = rootKey,
        myRatchetKeyPair = RatchetKeyPair(myIdentityPublic, myIdentityPrivate),
        theirRatchetPublicKeyB64 = exportRatchetPublicKey(peerIdentityPublic),
        sendChainKey = null,
        recvChainKey = null,
        sendMessageNumber = 0,
        recvMessageNumber = 0,
        previousSendChainLength = 0,
    )
}

/** Advance the DH ratchet: mix a fresh DH result into the root key, derive a new chain key. */
private fun dhRatchetStep(
    rootKey: ByteArray,
    myPrivate: X25519PrivateKeyParameters,
    theirPublic: X25519PublicKeyParameters,
): Pair<ByteArray, ByteArray> {
    val dh = ecdhBits(myPrivate, theirPublic)
    val out = hkdf(dh, rootKey, HKDF_INFO_DH, 64)
    return out.copyOfRange(0, 32) to out.copyOfRange(32, 64)
}

private fun pushSkipped(session: RatchetSession, entry: SkippedKey) {
    session.skippedKeys.add(entry)
    while (session.skippedKeys.size > MAX_SKIPPED_KEYS) session.skippedKeys.removeAt(0)
}

private fun takeSkipped(session: RatchetSession, ratchetPublicKeyB64: String, messageNumber: Int): ByteArray? {
    val idx = session.skippedKeys.indexOfFirst {
        it.ratchetPublicKeyB64 == ratchetPublicKeyB64 && it.messageNumber == messageNumber
    }
    if (idx == -1) return null
    val found = session.skippedKeys.removeAt(idx)
    return fromBase64(found.messageKeyB64)
}

/** Advance recvChainKey forward to `upTo`, caching each derived key as skipped (not returned). */
private fun skipForward(session: RatchetSession, ratchetPublicKeyB64: String, upTo: Int) {
    if (session.recvChainKey == null) return
    val count = upTo - session.recvMessageNumber
    if (count <= 0) return
    if (count > MAX_SKIP_PER_STEP) {
        throw RatchetError("refusing to derive $count skipped keys in one step")
    }
    for (i in 0 until count) {
        val (messageKey, nextChainKey) = stepChain(session.recvChainKey!!)
        pushSkipped(
            session,
            SkippedKey(
                ratchetPublicKeyB64 = ratchetPublicKeyB64,
                messageNumber = session.recvMessageNumber + i,
                messageKeyB64 = toBase64(messageKey),
            ),
        )
        session.recvChainKey = nextChainKey
    }
    session.recvMessageNumber = upTo
}

data class RatchetEncryptResult(val messageKey: SecretKey, val header: RatchetMessageHeader)

/** Sender side: derive the next message key, mutating the session in place. */
fun ratchetEncrypt(session: RatchetSession): RatchetEncryptResult {
    if (session.sendChainKey == null) {
        val theirPublic = importRatchetPublicKey(session.theirRatchetPublicKeyB64)
        val (newRootKey, chainKey) = dhRatchetStep(session.rootKey, session.myRatchetKeyPair.privateKey, theirPublic)
        session.rootKey = newRootKey
        session.sendChainKey = chainKey
        session.previousSendChainLength = session.sendMessageNumber
        session.sendMessageNumber = 0
    }
    val (messageKey, nextChainKey) = stepChain(session.sendChainKey!!)
    val header = RatchetMessageHeader(
        ratchetPublicKeyB64 = exportRatchetPublicKey(session.myRatchetKeyPair.publicKey),
        messageNumber = session.sendMessageNumber,
        previousChainLength = session.previousSendChainLength,
    )
    session.sendChainKey = nextChainKey
    session.sendMessageNumber += 1
    return RatchetEncryptResult(importAesKey(messageKey), header)
}

/**
 * Receiver side: derive the message key matching this header, mutating
 * the session in place (performing a DH ratchet step if the peer's key
 * changed — or if we've never received anything yet — and caching any
 * skipped-over keys for later out-of-order arrivals).
 */
fun ratchetDecrypt(session: RatchetSession, header: RatchetMessageHeader): SecretKey {
    val cached = takeSkipped(session, header.ratchetPublicKeyB64, header.messageNumber)
    if (cached != null) return importAesKey(cached)

    if (header.ratchetPublicKeyB64 != session.theirRatchetPublicKeyB64 || session.recvChainKey == null) {
        if (session.recvChainKey != null) {
            // Drain whatever's left of the OLD receiving chain (bounded by the
            // sender's declared previous-chain length) so late arrivals on it
            // can still be found in the skipped-key cache.
            skipForward(session, session.theirRatchetPublicKeyB64, header.previousChainLength)
        }
        val theirNewPublic = importRatchetPublicKey(header.ratchetPublicKeyB64)
        val (newRootKey, chainKey) = dhRatchetStep(session.rootKey, session.myRatchetKeyPair.privateKey, theirNewPublic)
        session.rootKey = newRootKey
        session.recvChainKey = chainKey
        session.recvMessageNumber = 0
        session.theirRatchetPublicKeyB64 = header.ratchetPublicKeyB64
        // Force a fresh sending step next time we send, with fresh ephemeral
        // material — this is what "heals" the session after a round trip.
        session.sendChainKey = null
        session.myRatchetKeyPair = generateRatchetKeyPair()
    }

    if (session.recvChainKey == null) {
        throw RatchetError("no receiving chain established for this header")
    }
    if (header.messageNumber < session.recvMessageNumber) {
        throw RatchetError(
            "message ${header.messageNumber} on the current chain was already consumed and is not in the skipped-key cache",
        )
    }
    if (header.messageNumber > session.recvMessageNumber) {
        skipForward(session, header.ratchetPublicKeyB64, header.messageNumber)
    }
    val (messageKey, nextChainKey) = stepChain(session.recvChainKey!!)
    session.recvChainKey = nextChainKey
    session.recvMessageNumber = header.messageNumber + 1
    return importAesKey(messageKey)
}
