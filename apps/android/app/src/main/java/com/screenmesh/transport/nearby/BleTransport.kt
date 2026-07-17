package com.screenmesh.transport.nearby

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import android.util.Log
import com.screenmesh.transport.Connection
import com.screenmesh.transport.MeshTransport
import com.screenmesh.transport.Peer
import com.screenmesh.transport.TransportKind
import com.screenmesh.transport.TransportStatus
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

private const val TAG = "BleTransport"

/** ScreenMesh's GATT service — one characteristic carries chunked SecureEnvelope JSON bytes. */
private val SERVICE_UUID: UUID = UUID.fromString("5c7d0d9e-6b0a-4f7d-9c1a-2b6e4f8a3d10")
private val ENVELOPE_CHARACTERISTIC_UUID: UUID = UUID.fromString("5c7d0d9e-6b0a-4f7d-9c1a-2b6e4f8a3d11")

/** Standard Bluetooth SIG Client Characteristic Configuration Descriptor UUID. */
private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/**
 * Real (not stubbed) BLE transport. Every ScreenMesh phone acts as BOTH a
 * GATT peripheral (advertises the ScreenMesh service so nearby phones can
 * find and write to it) and a GATT central (scans for the same service on
 * other phones and connects to them) at the same time — there's no fixed
 * "host"/"client" role in a phone-to-phone mesh.
 *
 * BLE's negotiated MTU is small (23 bytes default, up to ~517 after
 * `requestMtu`), so each SecureEnvelope JSON blob is framed with a 4-byte
 * big-endian total-length header on its first chunk and reassembled on
 * the other end. Fragmentation into multiple sub-MTU writes for messages
 * LARGER than one negotiated MTU is NOT implemented — `send()` assumes
 * the whole framed message fits in a single GATT write/notify, which
 * holds for pairing codes and short text objects but not large files (see
 * docs/Android.md; this transport is meant for nearby pairing and small
 * handoffs, matching docs/Roadmap.md Phase 3's "nearby pairing only"
 * framing, not bulk transfer).
 *
 * UNTESTED: written against the documented android.bluetooth/.le APIs
 * with no device available in this environment to run it on. See
 * docs/Android.md. Runtime permission requests (BLUETOOTH_SCAN/
 * ADVERTISE/CONNECT on API 31+, or BLUETOOTH/ACCESS_FINE_LOCATION below
 * it) must be granted by the caller BEFORE calling start() — this class
 * does not request permissions itself, since that requires an Activity.
 */
@SuppressLint("MissingPermission") // caller is responsible for requesting BLE permissions first
class BleTransport(private val context: Context) : MeshTransport {
    override val kind: TransportKind = TransportKind.NEARBY

    private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager.adapter

    private var gattServer: BluetoothGattServer? = null
    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null

    /** Centrals (other phones) currently connected TO our peripheral role. */
    private val connectedCentrals = CopyOnWriteArrayList<BluetoothDevice>()

    /** Peripherals (other phones) we connected to in our central role. */
    private val connectedPeripherals = ConcurrentHashMap<String, BluetoothGatt>()
    private val discoveredPeers = ConcurrentHashMap<String, BluetoothDevice>()

    /** In-progress reassembly buffers, keyed by remote device address. */
    private val incoming = ConcurrentHashMap<String, Reassembly>()

    private val messageHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    private val statusHandlers = CopyOnWriteArrayList<(TransportStatus) -> Unit>()

    private var status: TransportStatus = TransportStatus.IDLE
        set(value) {
            if (field == value) return
            field = value
            statusHandlers.forEach { it(value) }
        }

    private class Reassembly(val total: Int) {
        val buffer = ByteArrayOutputStream()
    }

    /** Start advertising (peripheral role) and scanning (central role) simultaneously. */
    fun start() {
        val bleAdapter = adapter
        if (bleAdapter == null) {
            Log.w(TAG, "no Bluetooth adapter on this device")
            return
        }
        status = TransportStatus.DISCOVERING
        startGattServer()
        startAdvertising(bleAdapter)
        startScanning(bleAdapter)
    }

    fun stop() {
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
        runCatching { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
        runCatching { gattServer?.close() }
        connectedPeripherals.values.forEach { runCatching { it.close() } }
        connectedPeripherals.clear()
        connectedCentrals.clear()
        discoveredPeers.clear()
        incoming.clear()
        status = TransportStatus.IDLE
    }

    private fun startGattServer() {
        val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val characteristic = BluetoothGattCharacteristic(
            ENVELOPE_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val cccd = BluetoothGattDescriptor(
            CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
        )
        characteristic.addDescriptor(cccd)
        service.addCharacteristic(characteristic)

        val callback = object : BluetoothGattServerCallback() {
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> connectedCentrals.add(device)
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        connectedCentrals.remove(device)
                        incoming.remove(device.address)
                    }
                }
            }

            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                characteristic: BluetoothGattCharacteristic,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray,
            ) {
                if (characteristic.uuid == ENVELOPE_CHARACTERISTIC_UUID) {
                    handleChunk(device.address, value)
                }
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
                }
            }

            override fun onDescriptorWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                descriptor: BluetoothGattDescriptor,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray,
            ) {
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
                }
            }
        }
        val server = bluetoothManager.openGattServer(context, callback)
        server?.addService(service)
        gattServer = server
    }

    private fun startAdvertising(bleAdapter: BluetoothAdapter) {
        val advertiser = bleAdapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            Log.w(TAG, "device cannot advertise BLE")
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .build()
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(SERVICE_UUID))
            .setIncludeDeviceName(true)
            .build()
        val callback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                Log.w(TAG, "BLE advertise start failed: $errorCode")
            }
        }
        advertiser.startAdvertising(settings, data, callback)
        advertiseCallback = callback
    }

    private fun startScanning(bleAdapter: BluetoothAdapter) {
        val scanner = bleAdapter.bluetoothLeScanner
        if (scanner == null) {
            Log.w(TAG, "device cannot scan BLE")
            return
        }
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val device = result.device
                if (discoveredPeers.putIfAbsent(device.address, device) == null) {
                    connectToPeripheral(device)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "BLE scan failed: $errorCode")
            }
        }
        scanner.startScan(listOf(filter), settings, callback)
        scanCallback = callback
    }

    private fun connectToPeripheral(device: BluetoothDevice) {
        device.connectGatt(
            context,
            false,
            object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                    when (newState) {
                        BluetoothProfile.STATE_CONNECTED -> gatt.requestMtu(517)
                        BluetoothProfile.STATE_DISCONNECTED -> {
                            connectedPeripherals.remove(device.address)
                            incoming.remove(device.address)
                            gatt.close()
                        }
                    }
                }

                override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                    gatt.discoverServices()
                }

                override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                    connectedPeripherals[device.address] = gatt
                    val characteristic = gatt.getService(SERVICE_UUID)
                        ?.getCharacteristic(ENVELOPE_CHARACTERISTIC_UUID)
                        ?: return
                    gatt.setCharacteristicNotification(characteristic, true)
                    val cccd = characteristic.getDescriptor(CCCD_UUID)
                    if (cccd != null) {
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        gatt.writeDescriptor(cccd)
                    }
                }

                override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
                    if (characteristic.uuid == ENVELOPE_CHARACTERISTIC_UUID) {
                        handleChunk(device.address, characteristic.value ?: return)
                    }
                }
            },
        )
    }

    private fun handleChunk(fromAddress: String, chunk: ByteArray) {
        val existing = incoming[fromAddress]
        if (existing == null) {
            if (chunk.size < 4) return
            val total = ByteBuffer.wrap(chunk, 0, 4).int
            val reassembly = Reassembly(total)
            reassembly.buffer.write(chunk, 4, chunk.size - 4)
            incoming[fromAddress] = reassembly
            maybeComplete(fromAddress, reassembly)
        } else {
            existing.buffer.write(chunk, 0, chunk.size)
            maybeComplete(fromAddress, existing)
        }
    }

    private fun maybeComplete(fromAddress: String, reassembly: Reassembly) {
        if (reassembly.buffer.size() >= reassembly.total) {
            incoming.remove(fromAddress)
            val bytes = reassembly.buffer.toByteArray()
            messageHandlers.forEach { it(bytes) }
        }
    }

    // --- MeshTransport ---

    override fun discover(): List<Peer> = discoveredPeers.values.map {
        Peer(deviceId = it.address, name = it.name ?: it.address, transport = kind)
    }

    override fun connect(peer: Peer): Connection = Connection(peer) {}

    /**
     * Sends to every currently connected peer, both as a central (GATT
     * write to peripherals we connected to) and as a peripheral (notify
     * to centrals connected to us) — broadcasts to everyone nearby rather
     * than addressing one peer, since BLE addresses (device.address)
     * aren't ScreenMesh device IDs and there's no address<->deviceId
     * mapping surfaced through the MeshTransport interface yet.
     */
    override fun send(data: ByteArray) {
        val framed = ByteBuffer.allocate(4 + data.size).putInt(data.size).array() + data

        connectedPeripherals.values.forEach { gatt ->
            val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(ENVELOPE_CHARACTERISTIC_UUID)
            if (characteristic != null) {
                characteristic.value = framed
                gatt.writeCharacteristic(characteristic)
            }
        }
        val serverCharacteristic = gattServer?.getService(SERVICE_UUID)?.getCharacteristic(ENVELOPE_CHARACTERISTIC_UUID)
        if (serverCharacteristic != null) {
            serverCharacteristic.value = framed
            connectedCentrals.forEach { device ->
                gattServer?.notifyCharacteristicChanged(device, serverCharacteristic, false)
            }
        }
    }

    override fun disconnect() = stop()

    override fun onMessage(handler: (ByteArray) -> Unit) {
        messageHandlers.add(handler)
    }

    override fun onStatusChange(handler: (TransportStatus) -> Unit) {
        statusHandlers.add(handler)
    }
}
