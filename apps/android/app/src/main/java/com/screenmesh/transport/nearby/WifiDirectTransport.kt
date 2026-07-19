package com.screenmesh.transport.nearby

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.util.Log
import com.screenmesh.transport.Connection
import com.screenmesh.transport.MeshTransport
import com.screenmesh.transport.Peer
import com.screenmesh.transport.TransportKind
import com.screenmesh.transport.TransportStatus
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TAG = "WifiDirectTransport"
private const val PORT = 8988

/**
 * Real (not stubbed) Wi-Fi Direct transport: discovers peers via
 * WifiP2pManager, negotiates a group on connect, then carries
 * length-prefixed SecureEnvelope JSON bytes over a plain TCP socket
 * between the group owner and the client — no MTU concerns here, unlike
 * BLE, since it's an ordinary socket once the group forms.
 *
 * The OS delivers group-formation progress via broadcasts
 * (`WIFI_P2P_PEERS_CHANGED_ACTION`, `WIFI_P2P_CONNECTION_CHANGED_ACTION`),
 * which are inherently Activity/lifecycle-bound — this class exposes
 * `refreshPeers()` and `handleConnectionChanged()` for the hosting
 * Activity's `BroadcastReceiver` to call on those two actions
 * respectively, rather than registering its own receiver (this class has
 * no Activity to tie that registration's lifecycle to). Wired into
 * MainActivity's "Scan nearby (Wi-Fi Direct)" button.
 *
 * UNTESTED: written against the documented android.net.wifi.p2p APIs
 * with no device pair available in this environment to run it on. See
 * docs/Android.md. Requires ACCESS_WIFI_STATE/CHANGE_WIFI_STATE and
 * (API < 33) ACCESS_FINE_LOCATION, or (API 33+) NEARBY_WIFI_DEVICES,
 * requested by the caller before start() — this class does not request
 * permissions itself.
 */
@SuppressLint("MissingPermission") // caller is responsible for requesting Wi-Fi Direct permissions first
class WifiDirectTransport(private val context: Context) : MeshTransport {
    override val kind: TransportKind = TransportKind.NEARBY

    private val manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private var serverSocket: ServerSocket? = null
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val sockets = CopyOnWriteArrayList<Socket>()
    private val discoveredPeers = CopyOnWriteArrayList<WifiP2pDevice>()

    private val messageHandlers = CopyOnWriteArrayList<(ByteArray) -> Unit>()
    private val statusHandlers = CopyOnWriteArrayList<(TransportStatus) -> Unit>()

    private var status: TransportStatus = TransportStatus.IDLE
        set(value) {
            if (field == value) return
            field = value
            statusHandlers.forEach { it(value) }
        }

    /** Fired once per newly-discovered nearby Wi-Fi Direct peer. */
    @Volatile var onPeerDiscovered: ((Peer) -> Unit)? = null

    private val peerListListener = WifiP2pManager.PeerListListener { peers ->
        val previousAddresses = discoveredPeers.map { it.deviceAddress }.toSet()
        discoveredPeers.clear()
        discoveredPeers.addAll(peers.deviceList)
        for (device in peers.deviceList) {
            if (device.deviceAddress !in previousAddresses) {
                onPeerDiscovered?.invoke(Peer(deviceId = device.deviceAddress, name = device.deviceName, transport = kind))
            }
        }
    }

    fun start() {
        val ch = manager.initialize(context, context.mainLooper, null)
        if (ch == null) {
            Log.w(TAG, "Wi-Fi Direct is not supported on this device")
            return
        }
        channel = ch
        status = TransportStatus.DISCOVERING
        manager.discoverPeers(
            ch,
            object : WifiP2pManager.ActionListener {
                override fun onSuccess() = Unit
                override fun onFailure(reason: Int) {
                    Log.w(TAG, "Wi-Fi Direct discovery failed: $reason")
                }
            },
        )
        // Listen as a server too, in case a peer connects to us as group owner.
        startServerSocket()
    }

    fun stop() {
        channel?.let { manager.stopPeerDiscovery(it, null) }
        sockets.forEach { runCatching { it.close() } }
        sockets.clear()
        runCatching { serverSocket?.close() }
        serverSocket = null
        status = TransportStatus.IDLE
    }

    /** Call from the hosting Activity's WIFI_P2P_PEERS_CHANGED_ACTION receiver. */
    fun refreshPeers() {
        channel?.let { manager.requestPeers(it, peerListListener) }
    }

    fun connectToPeer(device: WifiP2pDevice) {
        val config = WifiP2pConfig().apply { deviceAddress = device.deviceAddress }
        val ch = channel ?: return
        manager.connect(
            ch,
            config,
            object : WifiP2pManager.ActionListener {
                override fun onSuccess() = Unit
                override fun onFailure(reason: Int) {
                    Log.w(TAG, "Wi-Fi Direct connect to ${device.deviceAddress} failed: $reason")
                }
            },
        )
    }

    /**
     * Call directly from the hosting Activity's
     * WIFI_P2P_CONNECTION_CHANGED_ACTION receiver — resolves the
     * connection info via our own `channel` (kept private so the Activity
     * doesn't need direct WifiP2pManager.Channel access) and, if this
     * device isn't the group owner, connects to it via
     * [onGroupOwnerAddressKnown]. The group-owner side needs no action
     * here — startServerSocket's accept loop handles it.
     */
    fun handleConnectionChanged() {
        val ch = channel ?: return
        manager.requestConnectionInfo(ch) { info ->
            val address = info.groupOwnerAddress
            if (info.groupFormed && !info.isGroupOwner && address != null) {
                address.hostAddress?.let { onGroupOwnerAddressKnown(it) }
            }
        }
    }

    /**
     * Call once the hosting Activity's WIFI_P2P_CONNECTION_CHANGED_ACTION
     * receiver resolves a connected group with a known group-owner address
     * (via `manager.requestConnectionInfo`) — opens the client-side socket
     * to it. The group-owner side is handled by startServerSocket's accept
     * loop instead; only the non-owner side calls this.
     */
    fun onGroupOwnerAddressKnown(groupOwnerAddress: String) {
        executor.execute {
            try {
                val socket = Socket()
                socket.connect(InetSocketAddress(groupOwnerAddress, PORT), 10_000)
                registerSocket(socket)
            } catch (e: Exception) {
                Log.w(TAG, "failed to connect to group owner $groupOwnerAddress", e)
            }
        }
    }

    private fun startServerSocket() {
        executor.execute {
            try {
                val server = ServerSocket(PORT)
                serverSocket = server
                while (!server.isClosed) {
                    val socket = server.accept()
                    registerSocket(socket)
                }
            } catch (e: Exception) {
                Log.d(TAG, "Wi-Fi Direct server socket stopped", e)
            }
        }
    }

    private fun registerSocket(socket: Socket) {
        sockets.add(socket)
        status = TransportStatus.CONNECTED
        executor.execute {
            try {
                val input = DataInputStream(socket.getInputStream())
                while (!socket.isClosed) {
                    val length = input.readInt()
                    val bytes = ByteArray(length)
                    input.readFully(bytes)
                    messageHandlers.forEach { it(bytes) }
                }
            } catch (e: Exception) {
                Log.d(TAG, "Wi-Fi Direct peer disconnected", e)
            } finally {
                sockets.remove(socket)
                runCatching { socket.close() }
            }
        }
    }

    // --- MeshTransport ---

    override fun discover(): List<Peer> = discoveredPeers.map {
        Peer(deviceId = it.deviceAddress, name = it.deviceName, transport = kind)
    }

    override fun connect(peer: Peer): Connection {
        discoveredPeers.find { it.deviceAddress == peer.deviceId }?.let { connectToPeer(it) }
        return Connection(peer) {}
    }

    /** Broadcasts to every connected socket — see BleTransport's send() doc comment for why. */
    override fun send(data: ByteArray) {
        val dead = mutableListOf<Socket>()
        for (socket in sockets) {
            try {
                val output = DataOutputStream(socket.getOutputStream())
                output.writeInt(data.size)
                output.write(data)
                output.flush()
            } catch (e: Exception) {
                dead.add(socket)
            }
        }
        sockets.removeAll(dead)
    }

    override fun disconnect() = stop()

    override fun onMessage(handler: (ByteArray) -> Unit) {
        messageHandlers.add(handler)
    }

    override fun onStatusChange(handler: (TransportStatus) -> Unit) {
        statusHandlers.add(handler)
    }
}
