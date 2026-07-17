package com.screenmesh.crypto

import java.util.Base64

/**
 * Kotlin mirror of packages/protocol/src/base64.ts. `java.util.Base64`'s
 * default (MIME-free) codec is standard base64 with padding, which is
 * byte-for-byte what browser btoa/atob produce for a byte string — no
 * chunking trick needed here since we're not going through a JS string
 * argument-count limit. Available since API 26 (this module's minSdk).
 */
fun toBase64(bytes: ByteArray): String =
    Base64.getEncoder().encodeToString(bytes)

fun fromBase64(b64: String): ByteArray =
    Base64.getDecoder().decode(b64)

/** Standard base64 → URL-safe (no +, /, or padding). */
fun base64ToUrlSafe(b64: String): String =
    b64.replace("+", "-").replace("/", "_").replace(Regex("=+$"), "")

/** URL-safe base64 → standard (padding restored). */
fun base64FromUrlSafe(urlSafe: String): String {
    var b64 = urlSafe.replace("-", "+").replace("_", "/")
    while (b64.length % 4 != 0) b64 += "="
    return b64
}
