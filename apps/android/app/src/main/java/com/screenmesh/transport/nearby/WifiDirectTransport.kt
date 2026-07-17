package com.screenmesh.transport.nearby

/**
 * STUB — Wi-Fi Direct pairing/transport. Deferred per the "protocol/crypto
 * port first" scoping decision: needs WifiP2pManager + a real device pair
 * to build and test. Not wired into MeshTransport yet — every method
 * throws.
 *
 * Plan for when real hardware is available (see docs/Android.md):
 *  - Discovery via WifiP2pManager.discoverPeers, group negotiation via
 *    connect(WifiP2pConfig).
 *  - Once a group forms, open a plain TCP socket between the group owner
 *    and client and carry SecureEnvelope JSON bytes over it — the crypto
 *    layer doesn't care which transport moved the bytes.
 *  - Permissions: ACCESS_WIFI_STATE, CHANGE_WIFI_STATE,
 *    NEARBY_WIFI_DEVICES (API 33+) or ACCESS_FINE_LOCATION (below it). See
 *    the commented block in AndroidManifest.xml.
 */
class WifiDirectTransport {
    fun discover(): Nothing =
        throw NotImplementedError("Wi-Fi Direct transport not yet implemented — needs a real Android device")

    fun connect(): Nothing =
        throw NotImplementedError("Wi-Fi Direct transport not yet implemented — needs a real Android device")

    fun send(data: ByteArray): Nothing =
        throw NotImplementedError("Wi-Fi Direct transport not yet implemented — needs a real Android device")
}
