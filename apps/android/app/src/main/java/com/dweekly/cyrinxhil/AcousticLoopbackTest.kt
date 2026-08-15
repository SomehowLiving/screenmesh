package com.dweekly.cyrinxhil

import kotlin.system.exitProcess

/**
 * Acoustic PHY loopback smoke test — NOT part of the shipped app: no
 * reference from AcousticTransport.kt, MainActivity, or the manifest, so
 * it has zero effect on the APK. Companion to
 * ../../screenmesh/InteropSmoke.kt's pattern: this file has no Android API
 * dependency (AcousticPhyLink/FFT/X25519 are plain Kotlin), so it's
 * compiled by the same `compileDebugKotlin` as the rest of the app but run
 * directly with `java`, not on a device/emulator.
 *
 * What this proves, and what it deliberately does NOT prove: there is no
 * second physical device and no way to route real audio between two
 * emulator instances in this environment, so the acoustic link has never
 * been exercised over real air — see docs/Android.md. What CAN be proven
 * without real air is that the actual DSP core (`AcousticPhyLink.encode`/
 * `.ingest` — OFDM/D-CSS modulation, preamble sync, header/body decode) is
 * internally self-consistent: encode a frame into audio samples on one
 * instance, run those samples through a simulated channel (silence
 * padding + additive noise, not just a bit-perfect passthrough), and
 * confirm a second, independent instance recovers the exact original
 * bytes. This is a real exercise of the modulation/demodulation math, not
 * a protocol-only mock — a bug in the OFDM symbol mapping, the preamble
 * correlator, or the header codec would fail this test. It does NOT
 * exercise `AndroidAudioBackend`'s real `AudioRecord`/`AudioTrack` I/O,
 * microphone/speaker frequency response, or any real-world echo/noise/
 * clock-drift a physical mic-speaker round trip would add.
 */
fun main() {
    val config = SessionConfig(role = Role.MASTER, enableCrypto = false)
    val txLink = AcousticPhyLink(config)
    val rxLink = AcousticPhyLink(config.copy(role = Role.SLAVE))

    val messages = listOf(
        "hello from Kotlin acoustic PHY".toByteArray(Charsets.UTF_8),
        ByteArray(200) { (it % 256).toByte() },
        "short".toByteArray(Charsets.UTF_8),
    )

    var allOk = true
    for ((index, message) in messages.withIndex()) {
        val samples = txLink.encode(message)

        // Simulated channel: silence before/after (as a real recording
        // would have) plus small additive noise, not a bit-perfect
        // passthrough — exercises the preamble correlator's tolerance,
        // not just the OFDM math on a pristine signal.
        val noiseAmplitude = 0.01f
        var seed = 0x2545F4914F6CDD1DL xor index.toLong()
        fun nextNoise(): Float {
            seed = seed xor (seed shl 13)
            seed = seed xor (seed ushr 7)
            seed = seed xor (seed shl 17)
            val unit = ((seed and 0xFFFFFF) / 16777216.0) - 0.5
            return (unit * 2.0 * noiseAmplitude).toFloat()
        }
        val paddingSamples = 4000
        val channelSamples = FloatArray(paddingSamples + samples.size + paddingSamples) { i ->
            val base = if (i in paddingSamples until paddingSamples + samples.size) {
                samples[i - paddingSamples]
            } else {
                0.0f
            }
            base + nextNoise()
        }

        val decoded = rxLink.ingest(channelSamples)
        val recovered = decoded.firstOrNull()?.frame

        val ok = recovered != null && recovered.contentEquals(message)
        println(
            "[$index] sent ${message.size} bytes, samples=${samples.size}, " +
                "decoded=${decoded.size} frame(s), match=$ok",
        )
        if (!ok) allOk = false
    }

    if (allOk) {
        println("ACOUSTIC PHY LOOPBACK OK")
    } else {
        println("ACOUSTIC PHY LOOPBACK FAILED")
        exitProcess(1)
    }
}
