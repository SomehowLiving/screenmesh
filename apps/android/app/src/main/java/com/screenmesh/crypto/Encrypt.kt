package com.screenmesh.crypto

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Kotlin mirror of packages/crypto/src/encrypt.ts. Uses the platform's
 * built-in javax.crypto AES-GCM — no BouncyCastle needed here, Android's
 * native AES-GCM has been solid since API 1 (unlike Ed25519/X25519).
 * `generateWorkspaceKey`'s output seeds every pairwise Double Ratchet
 * session (see Ratchet.kt) — actual message keys are ratchet-derived per
 * docs/Security.md §5, not this key directly.
 */

private const val AES_ALGORITHM = "AES"
private const val AES_GCM_TRANSFORM = "AES/GCM/NoPadding"
private const val GCM_TAG_BITS = 128
const val NONCE_BYTES = 12

fun generateWorkspaceKey(): SecretKey {
    val gen = KeyGenerator.getInstance(AES_ALGORITHM)
    gen.init(256, SecureRandom())
    return gen.generateKey()
}

/** Raw base64 export — used to share the key over the pairing QR channel. */
fun exportWorkspaceKey(key: SecretKey): String = toBase64(key.encoded)

fun importWorkspaceKey(b64: String): SecretKey = SecretKeySpec(fromBase64(b64), AES_ALGORITHM)

data class EncryptedPayload(val nonce: ByteArray, val ciphertext: ByteArray)

fun encrypt(key: SecretKey, plaintext: ByteArray): EncryptedPayload {
    val nonce = ByteArray(NONCE_BYTES).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance(AES_GCM_TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, nonce))
    val ciphertext = cipher.doFinal(plaintext)
    return EncryptedPayload(nonce, ciphertext)
}

fun decrypt(key: SecretKey, payload: EncryptedPayload): ByteArray {
    val cipher = Cipher.getInstance(AES_GCM_TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, payload.nonce))
    return cipher.doFinal(payload.ciphertext)
}
