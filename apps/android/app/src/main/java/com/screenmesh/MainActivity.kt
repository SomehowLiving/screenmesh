package com.screenmesh

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.p2p.WifiP2pManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.createPairingPayload
import com.screenmesh.crypto.decodePairingPayload
import com.screenmesh.crypto.encodePairingPayload
import com.screenmesh.crypto.exportWorkspaceKey
import com.screenmesh.crypto.generateIdentity
import com.screenmesh.crypto.importWorkspaceKey
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.sync.AppState
import com.screenmesh.sync.EngineConfig
import com.screenmesh.sync.LocalStateStore
import com.screenmesh.sync.MeshEngine
import com.screenmesh.sync.joinWorkspaceHttp
import com.screenmesh.sync.rotatePairingTokenHttp
import com.screenmesh.sync.serialize
import com.screenmesh.sync.toDeviceIdentity
import com.screenmesh.transport.Peer
import com.screenmesh.transport.RelayAuth
import com.screenmesh.transport.RelayTransport
import com.screenmesh.transport.nearby.BleTransport
import com.screenmesh.transport.nearby.NfcPairing
import com.screenmesh.transport.nearby.WifiDirectTransport
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.SecretKey

/** How long "Write to NFC tag" stays armed before a tag tap is treated as a plain read instead. */
private const val NFC_WRITE_ARM_WINDOW_MS = 30_000L

/**
 * Minimal reference UI (classic Views, no Compose) exercising MeshEngine
 * end to end against a real relay: join a workspace from a pairing code,
 * then send/receive plain text objects. This is intentionally bare — a
 * proof that the ported protocol/crypto/transport/sync stack actually
 * talks to the same relay the web PWA and desktop agent use, not a
 * finished app UI. See docs/Android.md.
 *
 * Persists identity + session (LocalStateStore) so relaunching the app
 * reconnects straight to the relay instead of needing a fresh pairing
 * code every time — the pairing token itself is single-use, so only the
 * FIRST join calls joinWorkspaceHttp; every subsequent launch just
 * reopens the relay connection with the same identity.
 *
 * Also exercises all three nearby-pairing bootstraps — BLE, NFC, and
 * (as a raw transport rather than a pairing bootstrap) Wi-Fi Direct.
 * None of these invent a new trust protocol: BLE and NFC both just move
 * the exact same "SM1.…" pairing-code string a QR carries, then fall
 * through to the ordinary decodePairingPayload + joinWorkspaceHttp flow.
 * All three are UNTESTED on real hardware — see docs/Android.md.
 */
class MainActivity : AppCompatActivity() {
    private val background: ExecutorService = Executors.newSingleThreadExecutor()
    private var engine: MeshEngine? = null
    private var bleTransport: BleTransport? = null
    private var wifiDirectTransport: WifiDirectTransport? = null
    private var wifiDirectReceiver: BroadcastReceiver? = null
    private lateinit var localState: LocalStateStore

    // Current session, kept around so "Advertise via BLE"/"Write to NFC
    // tag" can mint a new pairing token without the user re-entering
    // everything.
    private var currentIdentity: DeviceIdentity? = null
    private var currentServerUrl: String? = null
    private var currentWorkspaceId: String? = null
    private var currentOwnerDeviceId: String? = null
    private var currentWorkspaceKeyB64: String? = null

    /** Set while waiting for the next NFC tag tap to write a freshly-minted pairing code onto it. */
    private var pendingNfcWriteCode: String? = null
    private var pendingNfcWriteExpiresAt: Long = 0L

    private lateinit var serverUrlInput: EditText
    private lateinit var pairingCodeInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var joinButton: Button
    private lateinit var forgetButton: Button
    private lateinit var scanNearbyButton: Button
    private lateinit var advertiseButton: Button
    private lateinit var nfcWriteButton: Button
    private lateinit var wifiDirectScanButton: Button
    private lateinit var statusText: TextView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: Button
    private lateinit var logText: TextView

    private var pendingPermissionAction: (() -> Unit)? = null
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        if (results.values.all { it }) {
            pendingPermissionAction?.invoke()
        } else {
            setStatus("Permissions denied — can't use that nearby feature.")
        }
        pendingPermissionAction = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        localState = LocalStateStore(applicationContext)

        serverUrlInput = findViewById(R.id.et_server_url)
        pairingCodeInput = findViewById(R.id.et_pairing_code)
        deviceNameInput = findViewById(R.id.et_device_name)
        joinButton = findViewById(R.id.btn_join)
        forgetButton = findViewById(R.id.btn_forget)
        scanNearbyButton = findViewById(R.id.btn_scan_nearby)
        advertiseButton = findViewById(R.id.btn_advertise_ble)
        nfcWriteButton = findViewById(R.id.btn_nfc_write)
        wifiDirectScanButton = findViewById(R.id.btn_wifi_direct_scan)
        statusText = findViewById(R.id.tv_status)
        messageInput = findViewById(R.id.et_message)
        sendButton = findViewById(R.id.btn_send)
        logText = findViewById(R.id.tv_log)

        joinButton.setOnClickListener { onJoinClicked() }
        sendButton.setOnClickListener { onSendClicked() }
        forgetButton.setOnClickListener { onForgetClicked() }
        scanNearbyButton.setOnClickListener { withPermissions(blePermissions()) { startBleScan() } }
        advertiseButton.setOnClickListener { withPermissions(blePermissions()) { onAdvertiseViaBleClicked() } }
        nfcWriteButton.setOnClickListener { onNfcWriteClicked() }
        wifiDirectScanButton.setOnClickListener { withPermissions(wifiDirectPermissions()) { startWifiDirectScan() } }

        // A tag tap can cold-launch the Activity via the manifest's
        // NDEF_DISCOVERED filter — that intent arrives here, in
        // getIntent()/onCreate, not onNewIntent (onNewIntent only fires
        // for a warm re-launch of an already-running singleTop Activity).
        handleNfcIntent(intent)

        tryAutoResume()
    }

    /** On a fresh launch, reconnect from saved state instead of requiring a new pairing code. */
    private fun tryAutoResume() {
        val saved = localState.load() ?: return
        serverUrlInput.setText(saved.serverUrl)
        deviceNameInput.setText(saved.deviceName)
        setStatus("Reconnecting to \"${saved.workspaceId}\"...")
        background.execute {
            try {
                val identity = saved.identity.toDeviceIdentity()
                val workspaceKey = importWorkspaceKey(saved.workspaceKeyB64)
                startEngine(identity, saved.serverUrl, saved.workspaceId, saved.ownerDeviceId, workspaceKey, saved.workspaceKeyB64)
                runOnUiThread { setStatus("Reconnected as ${saved.deviceName}") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Reconnect failed: ${e.message}") }
            }
        }
    }

    private fun onJoinClicked() {
        val serverUrl = serverUrlInput.text.toString().trim().trimEnd('/')
        val code = pairingCodeInput.text.toString().trim()
        val deviceName = deviceNameInput.text.toString().trim().ifEmpty { "Android Phone" }
        if (serverUrl.isEmpty() || code.isEmpty()) {
            setStatus("Enter a server URL and pairing code first.")
            return
        }
        setStatus("Joining...")
        background.execute {
            try {
                val payload = decodePairingPayload(code)
                val identity = generateIdentity()
                val joined = joinWorkspaceHttp(serverUrl, payload.workspaceId, payload.pairingToken, identity, deviceName)
                val workspaceKey = importWorkspaceKey(payload.workspaceKey)

                localState.save(
                    AppState(
                        identity = identity.serialize(),
                        deviceName = deviceName,
                        workspaceId = joined.workspace.id,
                        ownerDeviceId = joined.workspace.ownerDeviceId,
                        serverUrl = serverUrl,
                        workspaceKeyB64 = exportWorkspaceKey(workspaceKey),
                    ),
                )
                startEngine(identity, serverUrl, joined.workspace.id, joined.workspace.ownerDeviceId, workspaceKey, payload.workspaceKey)
                runOnUiThread { setStatus("Joined \"${joined.workspace.name}\" as $deviceName") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Join failed: ${e.message}") }
            }
        }
    }

    /** Builds the relay transport + MeshEngine and starts it. Runs on the background executor. */
    private fun startEngine(
        identity: DeviceIdentity,
        serverUrl: String,
        workspaceId: String,
        ownerDeviceId: String,
        workspaceKey: SecretKey,
        workspaceKeyB64: String,
    ) {
        val relayWsUrl = Regex("^http").replaceFirst(serverUrl, "ws") + "/relay"
        val auth = object : RelayAuth {
            override val deviceId = identity.deviceId
            override val workspaceId = workspaceId
            override fun sign(data: ByteArray): ByteArray = com.screenmesh.crypto.sign(identity, data)
        }
        val transport = RelayTransport(relayWsUrl, auth)
        val newEngine = MeshEngine(
            EngineConfig(
                identity = identity,
                workspaceId = workspaceId,
                workspaceKey = workspaceKey,
                ownerDeviceId = ownerDeviceId,
                transport = transport,
                onObjectReceived = { obj, senderId ->
                    appendLog("Received from $senderId: ${obj.content}")
                },
            ),
        )
        engine?.stop()
        engine = newEngine
        currentIdentity = identity
        currentServerUrl = serverUrl
        currentWorkspaceId = workspaceId
        currentOwnerDeviceId = ownerDeviceId
        currentWorkspaceKeyB64 = workspaceKeyB64
        newEngine.start()
    }

    private fun onSendClicked() {
        val currentEngine = engine
        if (currentEngine == null) {
            setStatus("Join a workspace first.")
            return
        }
        val text = messageInput.text.toString()
        if (text.isEmpty()) return
        background.execute {
            try {
                val recipients = currentEngine.devicesSnapshot().map { it.id }
                if (recipients.isEmpty()) {
                    runOnUiThread { setStatus("No other devices in this workspace yet.") }
                    return@execute
                }
                val content = buildJsonObject { put("text", JsonPrimitive(text)) }
                currentEngine.sendObject(MeshObjectTypes.TEXT, content, recipients)
                runOnUiThread {
                    appendLog("Sent: $text")
                    messageInput.setText("")
                }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Send failed: ${e.message}") }
            }
        }
    }

    /** Local-only cleanup: forgets this device's identity and session, does not revoke it server-side. */
    private fun onForgetClicked() {
        val currentEngine = engine
        engine = null
        currentIdentity = null
        currentServerUrl = null
        currentWorkspaceId = null
        currentOwnerDeviceId = null
        currentWorkspaceKeyB64 = null
        localState.clear()
        pairingCodeInput.setText("")
        logText.text = ""
        setStatus("Forgot this device. Enter a fresh pairing code to join again.")
        if (currentEngine != null) {
            background.execute { currentEngine.stop() }
        }
    }

    // --- shared pairing-code minting (used by both the BLE and NFC bootstraps) ---

    /**
     * Mints a fresh single-use pairing token (owner-only server-side —
     * mirrors the web app's own invite action) and returns the encoded
     * pairing code. Must run off the main thread (does a blocking HTTP
     * call). Throws if not currently joined, or if the server rejects the
     * mint (e.g. this device isn't the workspace owner).
     */
    private fun mintPairingCode(): String {
        val serverUrl = currentServerUrl ?: error("join a workspace first")
        val workspaceId = currentWorkspaceId ?: error("join a workspace first")
        val identity = currentIdentity ?: error("join a workspace first")
        val workspaceKeyB64 = currentWorkspaceKeyB64 ?: error("join a workspace first")
        val payload = createPairingPayload(
            workspaceId = workspaceId,
            workspaceKey = workspaceKeyB64,
            now = System.currentTimeMillis(),
            serverUrl = serverUrl,
        )
        rotatePairingTokenHttp(serverUrl, workspaceId, identity.deviceId, payload.pairingToken, payload.expiresAt)
        return encodePairingPayload(payload)
    }

    // --- BLE nearby pairing bootstrap ---

    /** BLE runtime permissions needed for the current API level. */
    private fun blePermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT,
            )
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun bleTransportOrCreate(): BleTransport {
        var transport = bleTransport
        if (transport == null) {
            transport = BleTransport(applicationContext)
            bleTransport = transport
        }
        return transport
    }

    /** Scan nearby for a ScreenMesh peripheral offering a pairing code, and fill it in on the first one found. */
    private fun startBleScan() {
        val transport = bleTransportOrCreate()
        transport.onPeerDiscovered = { peer: Peer ->
            setStatus("Found nearby device ${peer.name} — reading its pairing code...")
            transport.requestPairingCode(peer) { code ->
                if (code != null) {
                    runOnUiThread {
                        pairingCodeInput.setText(code)
                        setStatus("Got a pairing code via BLE from ${peer.name} — tap Join workspace.")
                    }
                } else {
                    setStatus("${peer.name} isn't offering a pairing code right now.")
                }
            }
        }
        setStatus("Scanning for nearby ScreenMesh devices via BLE...")
        background.execute { transport.start() }
    }

    /** Mint a fresh pairing token and offer it to nearby scanners over BLE. */
    private fun onAdvertiseViaBleClicked() {
        setStatus("Minting a nearby pairing code...")
        background.execute {
            try {
                val code = mintPairingCode()
                val transport = bleTransportOrCreate()
                transport.localPairingCode = code
                transport.start()
                runOnUiThread {
                    setStatus("Advertising a pairing code via BLE for 5 minutes — have a nearby device tap Scan nearby.")
                }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Advertise failed: ${e.message}") }
            }
        }
    }

    // --- NFC nearby pairing bootstrap ---

    /** Mint a fresh pairing token and arm the next NFC tag tap (for a bounded window) to write it. */
    private fun onNfcWriteClicked() {
        setStatus("Minting a pairing code for NFC...")
        background.execute {
            try {
                val code = mintPairingCode()
                pendingNfcWriteCode = code
                pendingNfcWriteExpiresAt = System.currentTimeMillis() + NFC_WRITE_ARM_WINDOW_MS
                runOnUiThread { setStatus("Tap an NFC tag within 30s to write the pairing code (code itself is valid 5 minutes).") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("NFC mint failed: ${e.message}") }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNfcIntent(intent)
    }

    /**
     * Shared by onCreate (a tag tap can cold-launch the Activity via the
     * manifest's NDEF_DISCOVERED filter, delivered as getIntent()) and
     * onNewIntent (a warm re-launch of this already-running singleTop
     * Activity).
     */
    private fun handleNfcIntent(intent: Intent) {
        val writeCode = pendingNfcWriteCode
        if (writeCode != null && System.currentTimeMillis() < pendingNfcWriteExpiresAt) {
            @Suppress("DEPRECATION") // typed getParcelableExtra overload is API 33+; minSdk here is 26
            val tag = intent.getParcelableExtra<Tag>(NfcAdapter.EXTRA_TAG)
            if (tag != null) {
                pendingNfcWriteCode = null
                background.execute {
                    try {
                        NfcPairing.writePairingCodeToTag(tag, writeCode)
                        runOnUiThread { setStatus("Wrote pairing code to NFC tag.") }
                    } catch (e: Exception) {
                        runOnUiThread { setStatus("NFC write failed: ${e.message}") }
                    }
                }
                return
            }
        } else {
            // Expired (or was never armed) — don't let a stale write-mode
            // arm silently overwrite/reformat a tag the user only meant
            // to read, arbitrarily long after the button was tapped.
            pendingNfcWriteCode = null
        }

        val code = NfcPairing.readPairingCodeFromIntent(intent)
        if (code != null) {
            pairingCodeInput.setText(code)
            setStatus("Got a pairing code via NFC tap — tap Join workspace.")
        }
    }

    override fun onResume() {
        super.onResume()
        NfcPairing.enableForegroundDispatch(this)
    }

    override fun onPause() {
        NfcPairing.disableForegroundDispatch(this)
        super.onPause()
    }

    // --- Wi-Fi Direct (raw transport, not a pairing bootstrap — see docs/Android.md) ---

    private fun wifiDirectPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }

    private fun startWifiDirectScan() {
        if (wifiDirectReceiver == null) {
            val filter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            }
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    when (intent.action) {
                        WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> wifiDirectTransport?.refreshPeers()
                        WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> wifiDirectTransport?.handleConnectionChanged()
                    }
                }
            }
            ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            wifiDirectReceiver = receiver
        }

        // Guard against re-registering onStatusChange handlers (it appends,
        // never replaces) and re-binding the server socket on repeat
        // clicks — only ever construct and start one transport instance.
        if (wifiDirectTransport != null) {
            setStatus("Already scanning for nearby Wi-Fi Direct devices.")
            return
        }
        val transport = WifiDirectTransport(applicationContext)
        wifiDirectTransport = transport
        transport.onPeerDiscovered = { peer ->
            appendLog("Wi-Fi Direct: found nearby device ${peer.name}, connecting...")
            transport.connect(peer)
        }
        transport.onStatusChange { status ->
            appendLog("Wi-Fi Direct status: $status")
        }
        setStatus("Scanning for nearby Wi-Fi Direct devices...")
        background.execute { transport.start() }
    }

    private fun withPermissions(permissions: Array<String>, action: () -> Unit) {
        val granted = permissions.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        if (granted) {
            action()
        } else {
            pendingPermissionAction = action
            permissionLauncher.launch(permissions)
        }
    }

    private fun setStatus(text: String) {
        runOnUiThread { statusText.text = text }
    }

    private fun appendLog(line: String) {
        runOnUiThread { logText.append("\n$line") }
    }

    override fun onDestroy() {
        super.onDestroy()
        engine?.let { e -> background.execute { e.stop() } }
        bleTransport?.let { t -> background.execute { t.stop() } }
        wifiDirectTransport?.let { t -> background.execute { t.stop() } }
        wifiDirectReceiver?.let { runCatching { unregisterReceiver(it) } }
        background.shutdown()
    }
}
