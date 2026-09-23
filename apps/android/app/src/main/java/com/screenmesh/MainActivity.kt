package com.screenmesh

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.p2p.WifiP2pManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.createPairingPayload
import com.screenmesh.crypto.decodePairingPayload
import com.screenmesh.crypto.encodePairingPayload
import com.screenmesh.crypto.exportWorkspaceKey
import com.screenmesh.crypto.generateIdentity
import com.screenmesh.crypto.importWorkspaceKey
import com.screenmesh.protocol.AgentTaskContent
import com.screenmesh.protocol.ChecklistContent
import com.screenmesh.protocol.ChecklistItem
import com.screenmesh.protocol.FileContent
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.protocol.SendOptions
import com.screenmesh.protocol.TextContent
import com.screenmesh.sync.AppState
import com.screenmesh.sync.EngineConfig
import com.screenmesh.sync.DirectChannel
import com.screenmesh.sync.FileChunkStore
import com.screenmesh.sync.LocalEngineStateStore
import com.screenmesh.sync.LocalStateStore
import com.screenmesh.sync.MeshEngine
import com.screenmesh.sync.ObjectLocalState
import com.screenmesh.sync.ObjectLocalStateStore
import com.screenmesh.sync.joinWorkspaceHttp
import com.screenmesh.sync.verifyLanCompanionBootstrap
import com.screenmesh.sync.rotatePairingTokenHttp
import com.screenmesh.sync.serialize
import com.screenmesh.sync.toDeviceIdentity
import com.screenmesh.transport.Peer
import com.screenmesh.transport.RelayAuth
import com.screenmesh.transport.RelayTransport
import com.screenmesh.transport.nearby.AcousticTransport
import com.screenmesh.transport.nearby.BleTransport
import com.screenmesh.transport.nearby.NfcPairing
import com.screenmesh.transport.nearby.WifiDirectTransport
import com.screenmesh.ui.EXPIRY_CHOICES
import com.screenmesh.ui.ScreenMeshActions
import com.screenmesh.ui.ScreenMeshApp
import com.screenmesh.ui.ScreenMeshTheme
import com.screenmesh.ui.ScreenMeshUiState
import com.screenmesh.ui.Screen
import com.screenmesh.ui.encodeQrBitmap
import com.dweekly.cyrinxhil.Role as AcousticRole
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.SecretKey

/** How long "Write to NFC tag" stays armed before a tag tap is treated as a plain read instead. */
private const val NFC_WRITE_ARM_WINDOW_MS = 30_000L

/** Mirrors Send.tsx's MAX_FILE_BYTES — bounded mainly to keep memory use on
 *  the sending device reasonable; files above ~150KB base64 already travel
 *  chunked (see MeshEngine.kt's FILE_CHUNK_SIZE_B64), so the ceiling here is
 *  generous, not a chunking threshold. */
private const val MAX_FILE_BYTES = 25 * 1024 * 1024

private fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
}

/**
 * Compose-based reference UI exercising MeshEngine end to end against a
 * real relay: join a workspace from a pairing code, then send/receive
 * plain text objects, see the paired-device roster, and invite new devices
 * via a generated QR/code. All business logic here is unchanged from the
 * original Views-based UI — see docs/Android.md — only how it's presented
 * moved to Jetpack Compose (the com.screenmesh.ui package), so it reads and feels
 * like the same product as the web PWA instead of a raw debug harness.
 *
 * Also exercises all three radio-based nearby-pairing bootstraps — BLE,
 * NFC, and (as a raw transport rather than a pairing bootstrap) Wi-Fi
 * Direct — plus a fourth, non-radio transport: acoustic (near-ultrasonic
 * sound over the mic/speaker, via the vendored `com.dweekly.cyrinxhil`
 * DSP — see `AcousticTransport.kt`). BLE and NFC both just move the exact
 * same "SM1.…" pairing-code string a QR carries, then fall through to
 * the ordinary decodePairingPayload + joinWorkspaceHttp flow; acoustic
 * has no pairing bootstrap of its own yet, just a manual
 * initiator/responder start. All four are UNTESTED on real hardware —
 * see docs/Android.md — and live behind the UI's collapsed "Advanced"
 * section rather than the primary flow.
 */
class MainActivity : ComponentActivity() {
    private val background: ExecutorService = Executors.newSingleThreadExecutor()
    private var engine: MeshEngine? = null
    private var bleTransport: BleTransport? = null
    private var wifiDirectTransport: WifiDirectTransport? = null
    private var wifiDirectReceiver: BroadcastReceiver? = null
    private var acousticTransport: AcousticTransport? = null
    private lateinit var localState: LocalStateStore
    private lateinit var engineState: LocalEngineStateStore
    private lateinit var fileChunkStore: FileChunkStore
    private lateinit var objectLocalStateStore: ObjectLocalStateStore

    private val ui = ScreenMeshUiState()

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
        localState = LocalStateStore(applicationContext)
        engineState = LocalEngineStateStore(applicationContext)
        fileChunkStore = FileChunkStore(applicationContext)
        objectLocalStateStore = ObjectLocalStateStore(applicationContext)

        val actions = ScreenMeshActions(
            onJoin = { onJoinClicked() },
            onSend = { onSendClicked() },
            onForget = { onForgetClicked() },
            onScanBle = { withPermissions(blePermissions()) { startBleScan() } },
            onAdvertiseBle = { withPermissions(blePermissions()) { onAdvertiseViaBleClicked() } },
            onNfcWrite = { onNfcWriteClicked() },
            onWifiDirectScan = { withPermissions(wifiDirectPermissions()) { startWifiDirectScan() } },
            onAcousticInitiator = { withPermissions(acousticPermissions()) { startAcousticLink(AcousticRole.MASTER) } },
            onAcousticResponder = { withPermissions(acousticPermissions()) { startAcousticLink(AcousticRole.SLAVE) } },
            onMintPairCode = { onMintPairCodeClicked() },
            onCopyToClipboard = { text -> copyToClipboard(text) },
            onAttachFile = { uri -> onAttachFilePicked(uri) },
            onRefreshFeed = { refreshFeed() },
            onAcceptObject = { objectId -> background.execute { engine?.acceptObject(objectId); refreshFeed() } },
            onRejectObject = { objectId -> background.execute { engine?.rejectObject(objectId); refreshFeed() } },
            onMarkOpened = { objectId -> background.execute { engine?.markOpened(objectId); refreshFeed() } },
            onRetryDelivery = { deliveryId -> background.execute { engine?.retryDelivery(deliveryId); refreshFeed() } },
            onSaveFileToUri = { uri, file -> saveFileToUri(uri, file) },
            onTogglePin = { objectId -> updateObjectLocalState(objectId) { it.copy(pinned = !it.pinned) } },
            onToggleContinueLater = { objectId -> updateObjectLocalState(objectId) { it.copy(continueLater = !it.continueLater) } },
            onAddTag = { objectId, tag -> updateObjectLocalState(objectId) { it.copy(tags = (it.tags + tag).distinct()) } },
            onRemoveTag = { objectId, tag -> updateObjectLocalState(objectId) { it.copy(tags = it.tags - tag) } },
            onContinueOnDevice = { objectId, deviceId -> background.execute { engine?.continueOnDevice(objectId, deviceId) } },
        )
        setContent {
            ScreenMeshTheme {
                ScreenMeshApp(ui, actions)
            }
        }

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
        ui.serverUrl = saved.serverUrl
        ui.deviceName = saved.deviceName
        setStatus("Reconnecting to \"${saved.workspaceId}\"...")
        background.execute {
            try {
                val identity = saved.identity.toDeviceIdentity()
                val workspaceKey = importWorkspaceKey(saved.workspaceKeyB64)
                startEngine(identity, saved.serverUrl, saved.workspaceId, saved.ownerDeviceId, workspaceKey, saved.workspaceKeyB64)
                runOnUiThread {
                    ui.workspaceLabel = saved.deviceName
                    ui.screen = Screen.Workspace
                    setStatus("Reconnected as ${saved.deviceName}")
                }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Reconnect failed: ${e.message}") }
            }
        }
    }

    private fun onJoinClicked() {
        val serverUrl = ui.serverUrl.trim().trimEnd('/')
        val code = ui.pairingCodeField.trim()
        val deviceName = ui.deviceName.trim().ifEmpty { "Android Phone" }
        if (serverUrl.isEmpty() || code.isEmpty()) {
            setStatus("Enter a server URL and pairing code first.")
            return
        }
        runOnUiThread { ui.busy = true }
        setStatus("Joining...")
        background.execute {
            try {
                val payload = decodePairingPayload(code)
                val identity = generateIdentity()
                val joined = joinWorkspaceHttp(serverUrl, payload.workspaceId, payload.pairingToken, identity, deviceName)
                val workspaceKey = importWorkspaceKey(payload.workspaceKey)
                // The Android device identity is now known and relay-registered.
                // The pinned LAN bootstrap is additive: any failure leaves the
                // signed relay route available and never bypasses its checks.
                val localDirect = payload.lanEndpoint?.let {
                    runCatching { verifyLanCompanionBootstrap(it, identity.deviceId, joined.workspace.ownerDeviceId) }.getOrNull()
                }

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
                startEngine(identity, serverUrl, joined.workspace.id, joined.workspace.ownerDeviceId, workspaceKey, payload.workspaceKey, localDirect)
                runOnUiThread {
                    val route = if (payload.lanEndpoint != null && localDirect == null) " (local listener unavailable; relay fallback)" else if (localDirect != null) " (local companion connected)" else ""
                    ui.workspaceLabel = deviceName
                    ui.screen = Screen.Workspace
                    ui.busy = false
                    setStatus("Joined \"${joined.workspace.name}\" as $deviceName$route")
                }
            } catch (e: Exception) {
                runOnUiThread {
                    ui.busy = false
                    setStatus("Join failed: ${e.message}")
                }
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
        direct: DirectChannel? = null,
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
                direct = direct,
                onObjectReceived = { obj, senderId ->
                    appendLog("Received from $senderId: ${obj.content}")
                    refreshFeed()
                },
                onDevicesChanged = { devices -> runOnUiThread { ui.devices = devices.filter { it.id != identity.deviceId } } },
                stateStore = engineState,
                chunkStore = fileChunkStore,
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
        runOnUiThread {
            ui.myDeviceId = identity.deviceId
            ui.devices = newEngine.devicesSnapshot().filter { it.id != identity.deviceId }
            ui.objectLocalStates = objectLocalStateStore.load(workspaceId, identity.deviceId)
        }
        refreshFeed()
    }

    /** Pulls the engine's current objects/deliveries into UI state — see the
     *  Feed tab's poll loop (ScreenMeshApp.kt) for why this can't just be a
     *  one-shot push callback like onDevicesChanged/onObjectReceived. */
    private fun refreshFeed() {
        val currentEngine = engine ?: return
        val objects = currentEngine.objectsSnapshot()
        val deliveries = currentEngine.deliveriesSnapshot()
        runOnUiThread {
            ui.objects = objects
            ui.deliveries = deliveries
        }
    }

    /** Pin/tag/continue-later — purely local, never synced (see ObjectLocalStateStore's
     *  doc comment), so this just mutates UI state and persists, no engine call. */
    private fun updateObjectLocalState(objectId: String, transform: (ObjectLocalState) -> ObjectLocalState) {
        val workspaceId = currentWorkspaceId ?: return
        val deviceId = currentIdentity?.deviceId ?: return
        val current = ui.objectLocalStates[objectId] ?: ObjectLocalState()
        val updated = ui.objectLocalStates + (objectId to transform(current))
        ui.objectLocalStates = updated
        background.execute { objectLocalStateStore.save(workspaceId, deviceId, updated) }
    }

    /** Builds a "one checklist item per line" ChecklistContent — mirrors Send.tsx's checklist path. */
    private fun checklistContentFrom(text: String): ChecklistContent =
        ChecklistContent(
            items = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
                .map { line -> ChecklistItem(id = UUID.randomUUID().toString(), text = line, done = false) },
        )

    private fun onSendClicked() {
        val currentEngine = engine
        if (currentEngine == null) {
            setStatus("Join a workspace first.")
            return
        }
        val type = ui.composerType
        val text = ui.messageText
        if (type != MeshObjectTypes.AGENT_TASK && text.isEmpty()) return
        if (type == MeshObjectTypes.AGENT_TASK && ui.taskAction.isBlank()) return
        val capability = ui.targetCapability
        val expiresAt = EXPIRY_CHOICES.getOrNull(ui.expiryIndex)?.second?.let { System.currentTimeMillis() + it }
        val options = SendOptions(
            expiresAt = expiresAt,
            deleteAfterOpening = ui.deleteAfterOpening.takeIf { it },
            requireConfirmation = ui.requireConfirmation.takeIf { it },
        )
        val taskAction = ui.taskAction
        val taskParams = ui.taskParams
        background.execute {
            try {
                val recipients = if (capability != null) {
                    currentEngine.resolveCapability(capability).map { it.id }
                } else {
                    currentEngine.devicesSnapshot().map { it.id }
                }
                if (recipients.isEmpty()) {
                    runOnUiThread {
                        setStatus(if (capability != null) "No paired device currently advertises \"$capability\"." else "No other devices in this workspace yet.")
                    }
                    return@execute
                }
                val content = when (type) {
                    MeshObjectTypes.CHECKLIST -> Json.encodeToJsonElement(ChecklistContent.serializer(), checklistContentFrom(text))
                    MeshObjectTypes.AGENT_TASK -> {
                        val params = taskParams.trim().takeIf { it.isNotEmpty() && it != "{}" }?.let {
                            runCatching { Json.parseToJsonElement(it).jsonObject.toMap() }.getOrNull()
                        }
                        Json.encodeToJsonElement(AgentTaskContent.serializer(), AgentTaskContent(action = taskAction, params = params))
                    }
                    else -> Json.encodeToJsonElement(TextContent.serializer(), TextContent(text))
                }
                currentEngine.sendObject(type, content, recipients, options)
                runOnUiThread {
                    appendLog(if (type == MeshObjectTypes.AGENT_TASK) "Sent task: $taskAction" else "Sent ($type): $text")
                    ui.messageText = ""
                }
                refreshFeed()
            } catch (e: Exception) {
                runOnUiThread { setStatus("Send failed: ${e.message}") }
            }
        }
    }

    /**
     * Reads a file/image picked from the system document picker (Storage
     * Access Framework — no storage permission needed) and sends it to
     * everyone in the workspace. Mirrors Send.tsx's attach() + immediate
     * send rather than staging an attachment chip first — Android has no
     * per-recipient targeting yet (always "everyone"), so there's nothing
     * meaningful to stage a choice around.
     */
    private fun onAttachFilePicked(uri: Uri) {
        val currentEngine = engine
        if (currentEngine == null) {
            setStatus("Join a workspace first.")
            return
        }
        runOnUiThread { ui.busy = true }
        background.execute {
            try {
                val resolver = contentResolver
                val mimeType = resolver.getType(uri) ?: "application/octet-stream"
                var name = "file"
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && cursor.moveToFirst()) {
                        cursor.getString(nameIndex)?.let { name = it }
                    }
                }
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalStateException("Could not read the picked file")
                if (bytes.size > MAX_FILE_BYTES) {
                    runOnUiThread {
                        ui.busy = false
                        setStatus("File is too large (${formatSize(bytes.size.toLong())}) — the limit is 25 MB for now.")
                    }
                    return@execute
                }
                val recipients = currentEngine.devicesSnapshot().map { it.id }
                if (recipients.isEmpty()) {
                    runOnUiThread {
                        ui.busy = false
                        setStatus("No other devices in this workspace yet.")
                    }
                    return@execute
                }
                val fileContent = FileContent(name = name, mimeType = mimeType, size = bytes.size.toLong(), dataB64 = Base64.encodeToString(bytes, Base64.NO_WRAP))
                val objectType = if (mimeType.startsWith("image/")) MeshObjectTypes.IMAGE else MeshObjectTypes.FILE
                currentEngine.sendObject(objectType, Json.encodeToJsonElement(FileContent.serializer(), fileContent), recipients)
                runOnUiThread {
                    ui.busy = false
                    appendLog("Sent ${if (objectType == MeshObjectTypes.IMAGE) "image" else "file"}: $name (${formatSize(bytes.size.toLong())})")
                }
                refreshFeed()
            } catch (e: Exception) {
                runOnUiThread {
                    ui.busy = false
                    setStatus("Attach failed: ${e.message}")
                }
            }
        }
    }

    /** Writes a received file/image's bytes to the location the user picked
     *  via the system "save as" dialog (Storage Access Framework). */
    private fun saveFileToUri(uri: Uri, file: FileContent) {
        background.execute {
            try {
                val bytes = Base64.decode(file.dataB64, Base64.NO_WRAP)
                contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("Could not open the chosen location for writing")
                runOnUiThread { setStatus("Saved ${file.name}.") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Save failed: ${e.message}") }
            }
        }
    }

    /** Local-only cleanup: forgets this device's identity and session, does not revoke it server-side. */
    private fun onForgetClicked() {
        val currentEngine = engine
        val workspaceId = currentWorkspaceId
        val deviceId = currentIdentity?.deviceId
        engine = null
        currentIdentity = null
        currentServerUrl = null
        currentWorkspaceId = null
        currentOwnerDeviceId = null
        currentWorkspaceKeyB64 = null
        localState.clear()
        if (workspaceId != null && deviceId != null) {
            engineState.clear(workspaceId, deviceId)
            objectLocalStateStore.clear(workspaceId, deviceId)
        }
        ui.pairingCodeField = ""
        ui.logLines = emptyList()
        ui.devices = emptyList()
        ui.objects = emptyList()
        ui.deliveries = emptyList()
        ui.objectLocalStates = emptyMap()
        ui.myDeviceId = ""
        ui.workspaceLabel = null
        ui.mintedCode = null
        ui.mintedQr = null
        ui.screen = Screen.Onboarding
        setStatus("Forgot this device. Enter a fresh pairing code to join again.")
        if (currentEngine != null) {
            background.execute { currentEngine.stop() }
        }
    }

    // --- Pair screen: mint + display a fresh QR/code ---

    private fun onMintPairCodeClicked() {
        runOnUiThread { ui.pairBusy = true }
        background.execute {
            try {
                val code = mintPairingCode()
                val qr = encodeQrBitmap(code)
                runOnUiThread {
                    ui.mintedCode = code
                    ui.mintedQr = qr
                    ui.pairBusy = false
                }
            } catch (e: Exception) {
                runOnUiThread {
                    ui.pairBusy = false
                    setStatus("Couldn't generate a pairing code: ${e.message}")
                }
            }
        }
    }

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("ScreenMesh pairing code", text))
        setStatus("Copied to clipboard.")
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
        rotatePairingTokenHttp(serverUrl, workspaceId, identity, payload.pairingToken, payload.expiresAt)
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
                        ui.pairingCodeField = code
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
            runOnUiThread {
                ui.pairingCodeField = code
                setStatus("Got a pairing code via NFC tap — tap Join workspace.")
            }
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

    // --- Acoustic transport (near-ultrasonic, mic/speaker — see AcousticTransport.kt) ---

    private fun acousticPermissions(): Array<String> = arrayOf(Manifest.permission.RECORD_AUDIO)

    /**
     * Starts the acoustic link with this device in the given role — see
     * AcousticTransport's class doc comment for why the two sides must
     * agree out of band on who is MASTER (initiator) and who is SLAVE
     * (responder); there's no auto-negotiation. Two ScreenMesh devices
     * within earshot, one tapping "Start Acoustic (Initiator)" and the
     * other "Start Acoustic (Responder)", is the intended manual pairing
     * for this experimental transport — it does not (yet) carry a
     * pairing-code bootstrap the way BLE/NFC do.
     */
    private fun startAcousticLink(role: AcousticRole) {
        var transport = acousticTransport
        if (transport == null) {
            transport = AcousticTransport(applicationContext)
            acousticTransport = transport
            transport.onMessage { data ->
                appendLog("Acoustic: received ${data.size} bytes: ${String(data)}")
            }
            transport.onStatusChange { status ->
                appendLog("Acoustic status: $status")
            }
        }
        setStatus("Starting acoustic link as ${role.name.lowercase()} — this is slow (well under 1 kbps) and UNTESTED on real hardware.")
        background.execute { transport.start(role) }
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
        runOnUiThread { ui.status = text }
    }

    private fun appendLog(line: String) {
        runOnUiThread { ui.logLines = ui.logLines + line }
    }

    override fun onDestroy() {
        super.onDestroy()
        engine?.let { e -> background.execute { e.stop() } }
        bleTransport?.let { t -> background.execute { t.stop() } }
        wifiDirectTransport?.let { t -> background.execute { t.stop() } }
        wifiDirectReceiver?.let { runCatching { unregisterReceiver(it) } }
        acousticTransport?.let { t -> background.execute { t.stop() } }
        background.shutdown()
    }
}
