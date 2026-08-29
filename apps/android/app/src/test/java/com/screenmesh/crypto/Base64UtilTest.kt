package com.screenmesh.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Kotlin mirror of packages/protocol/src/base64.test.ts. */
class Base64UtilTest {
    @Test
    fun `round-trips empty input`() {
        assertArrayEquals(ByteArray(0), fromBase64(toBase64(ByteArray(0))))
    }

    @Test
    fun `round-trips arbitrary bytes including 0x00 and 0xFF`() {
        val bytes = byteArrayOf(0, 1, 2, -2 /* 254 */, -1 /* 255 */, -128 /* 128 */, 42)
        assertArrayEquals(bytes, fromBase64(toBase64(bytes)))
    }

    @Test
    fun `round-trips input larger than 64KB`() {
        val bytes = ByteArray(0x8000 * 2 + 137) { (it % 256).toByte() }
        assertArrayEquals(bytes, fromBase64(toBase64(bytes)))
    }

    @Test
    fun `base64ToUrlSafe strips +, slash, and padding, round-trips via base64FromUrlSafe`() {
        val bytes = byteArrayOf(-5 /* 0xFB */, -1 /* 0xFF */, -65 /* 0xBF */, 0)
        val standard = toBase64(bytes)
        assertTrue(standard.contains("+"))
        val urlSafe = base64ToUrlSafe(standard)
        assertFalse(urlSafe.contains("+"))
        assertFalse(urlSafe.contains("/"))
        assertFalse(urlSafe.contains("="))
        assertEquals(standard, base64FromUrlSafe(urlSafe))
        assertArrayEquals(bytes, fromBase64(base64FromUrlSafe(urlSafe)))
    }

    @Test
    fun `base64FromUrlSafe restores correct padding regardless of input length mod 4`() {
        for (byteLength in listOf(1, 2, 3, 4, 5, 16, 32)) {
            val bytes = ByteArray(byteLength) { it.toByte() }
            val roundTripped = fromBase64(base64FromUrlSafe(base64ToUrlSafe(toBase64(bytes))))
            assertArrayEquals(bytes, roundTripped)
        }
    }
}
