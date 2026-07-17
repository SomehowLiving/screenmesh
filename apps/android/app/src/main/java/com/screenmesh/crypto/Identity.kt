package com.screenmesh.crypto

import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.generators.X25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519KeyGenerationParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.PrivateKeyFactory
import org.bouncycastle.crypto.util.PrivateKeyInfoFactory
import java.security.SecureRandom
import java.util.UUID

/**
 * Kotlin mirror of packages/crypto/src/identity.ts, using BouncyCastle's
 * lightweight API instead of Web Crypto (Android's native Ed25519/X25519
 * support is inconsistent below API 33; BC works uniformly from
 * minSdk 26). There is no Android equivalent of Web Crypto's
 * non-extractable CryptoKey, so DeviceIdentity here is always a plain,
 * in-memory key-parameter object — callers are responsible for keeping it
 * out of logs and only exporting it deliberately via the PKCS8 functions
 * below (this mirrors the Node desktop-agent's persistence case in
 * packages/crypto/src/persist.ts, not the browser non-extractable case).
 */
data class DeviceIdentity(
    val deviceId: String,
    /** Ed25519 — signing. */
    val publicKey: Ed25519PublicKeyParameters,
    val privateKey: Ed25519PrivateKeyParameters,
    /** X25519 — key agreement (workspace key rotation, ratchet bootstrap). */
    val encryptionPublicKey: X25519PublicKeyParameters,
    val encryptionPrivateKey: X25519PrivateKeyParameters,
)

fun generateIdentity(): DeviceIdentity {
    val random = SecureRandom()

    val signingGen = Ed25519KeyPairGenerator()
    signingGen.init(Ed25519KeyGenerationParameters(random))
    val signingPair = signingGen.generateKeyPair()

    val agreementGen = X25519KeyPairGenerator()
    agreementGen.init(X25519KeyGenerationParameters(random))
    val agreementPair = agreementGen.generateKeyPair()

    return DeviceIdentity(
        deviceId = UUID.randomUUID().toString(),
        publicKey = signingPair.public as Ed25519PublicKeyParameters,
        privateKey = signingPair.private as Ed25519PrivateKeyParameters,
        encryptionPublicKey = agreementPair.public as X25519PublicKeyParameters,
        encryptionPrivateKey = agreementPair.private as X25519PrivateKeyParameters,
    )
}

/** Raw 32-byte Ed25519 public key, base64 — matches Web Crypto's exportKey("raw", ...). */
fun exportPublicKey(key: Ed25519PublicKeyParameters): String = toBase64(key.encoded)

fun importPublicKey(base64: String): Ed25519PublicKeyParameters =
    Ed25519PublicKeyParameters(fromBase64(base64), 0)

/** PKCS8 DER, base64 — matches Web Crypto's exportKey("pkcs8", ...) for Ed25519 (RFC 8410). */
fun exportEd25519PrivateKey(key: Ed25519PrivateKeyParameters): String =
    toBase64(PrivateKeyInfoFactory.createPrivateKeyInfo(key).encoded)

fun importEd25519PrivateKey(base64: String): Ed25519PrivateKeyParameters =
    PrivateKeyFactory.createKey(fromBase64(base64)) as Ed25519PrivateKeyParameters

fun sign(identity: DeviceIdentity, data: ByteArray): ByteArray {
    val signer = Ed25519Signer()
    signer.init(true, identity.privateKey)
    signer.update(data, 0, data.size)
    return signer.generateSignature()
}

fun verify(publicKey: Ed25519PublicKeyParameters, signature: ByteArray, data: ByteArray): Boolean {
    val signer = Ed25519Signer()
    signer.init(false, publicKey)
    signer.update(data, 0, data.size)
    return signer.verifySignature(signature)
}

/** Raw 32-byte X25519 public key, base64. */
fun exportEncryptionPublicKey(key: X25519PublicKeyParameters): String = toBase64(key.encoded)

fun importEncryptionPublicKey(base64: String): X25519PublicKeyParameters =
    X25519PublicKeyParameters(fromBase64(base64), 0)

/**
 * PKCS8 DER, base64 — mirrors packages/crypto/src/keywrap.ts's
 * exportEncryptionPrivateKey/importEncryptionPrivateKey (X25519 is RFC
 * 8410 PKCS8 too, same as Ed25519 above). Requires an extractable key,
 * which every BC key-parameter object effectively is — see the module
 * doc comment.
 */
fun exportEncryptionPrivateKey(key: X25519PrivateKeyParameters): String =
    toBase64(PrivateKeyInfoFactory.createPrivateKeyInfo(key).encoded)

fun importEncryptionPrivateKey(base64: String): X25519PrivateKeyParameters =
    PrivateKeyFactory.createKey(fromBase64(base64)) as X25519PrivateKeyParameters
