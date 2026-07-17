package com.screenmesh.transport.nearby

/**
 * STUB — Bluetooth LE pairing/transport. Deferred per the "protocol/crypto
 * port first" scoping decision: this needs a real Android device
 * (BluetoothManager, GATT client/server, a foreground service for
 * background scanning) to build and test, which this environment cannot
 * provide. Not wired into MeshTransport yet — every method throws.
 *
 * Plan for when real hardware is available (see docs/Android.md):
 *  - Peripheral role: advertise a ScreenMesh GATT service; a
 *    characteristic carries chunked EnvelopeJson bytes (BLE MTU is small,
 *    ~20-500 bytes, so envelopes need fragmentation/reassembly).
 *  - Central role: scan for the service UUID, connect, subscribe.
 *  - Permissions (API 31+): BLUETOOTH_SCAN, BLUETOOTH_ADVERTISE,
 *    BLUETOOTH_CONNECT. Pre-31: BLUETOOTH, BLUETOOTH_ADMIN,
 *    ACCESS_FINE_LOCATION. See the commented block in AndroidManifest.xml.
 */
class BleTransport {
    fun discover(): Nothing =
        throw NotImplementedError("BLE transport not yet implemented — needs a real Android device")

    fun connect(): Nothing =
        throw NotImplementedError("BLE transport not yet implemented — needs a real Android device")

    fun send(data: ByteArray): Nothing =
        throw NotImplementedError("BLE transport not yet implemented — needs a real Android device")
}
