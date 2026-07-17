package com.screenmesh.transport.nearby

/**
 * STUB — NFC tap-to-pair. Deferred per the "protocol/crypto port first"
 * scoping decision: needs NfcAdapter + two physical devices to build and
 * test. Not wired into anything yet — every method throws.
 *
 * Plan for when real hardware is available (see docs/Android.md): NFC is
 * pairing-only here, not a data transport (bandwidth/range are too
 * limited for envelope traffic) — an NDEF message carries the same
 * pairing-code string produced by com.screenmesh.crypto.encodePairingPayload
 * (the one normally scanned from a QR code), read via
 * NfcAdapter.setNdefPushMessage / Android Beam successor APIs or
 * host-card-emulation, so tapping two phones together is just another way
 * to deliver the pairing code instead of a camera scan.
 */
class NfcPairing {
    fun beginPairing(): Nothing =
        throw NotImplementedError("NFC pairing not yet implemented — needs a real Android device")
}
