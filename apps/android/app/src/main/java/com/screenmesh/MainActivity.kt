package com.screenmesh

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.decodePairingPayload
import com.screenmesh.crypto.exportWorkspaceKey
import com.screenmesh.crypto.generateIdentity
import com.screenmesh.crypto.importWorkspaceKey
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.sync.AppState
import com.screenmesh.sync.EngineConfig
import com.screenmesh.sync.LocalStateStore
import com.screenmesh.sync.MeshEngine
import com.screenmesh.sync.joinWorkspaceHttp
import com.screenmesh.sync.serialize
import com.screenmesh.sync.toDeviceIdentity
import com.screenmesh.transport.RelayAuth
import com.screenmesh.transport.RelayTransport
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.SecretKey

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
 */
class MainActivity : AppCompatActivity() {
    private val background: ExecutorService = Executors.newSingleThreadExecutor()
    private var engine: MeshEngine? = null
    private lateinit var localState: LocalStateStore

    private lateinit var serverUrlInput: EditText
    private lateinit var pairingCodeInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var joinButton: Button
    private lateinit var forgetButton: Button
    private lateinit var statusText: TextView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: Button
    private lateinit var logText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        localState = LocalStateStore(applicationContext)

        serverUrlInput = findViewById(R.id.et_server_url)
        pairingCodeInput = findViewById(R.id.et_pairing_code)
        deviceNameInput = findViewById(R.id.et_device_name)
        joinButton = findViewById(R.id.btn_join)
        forgetButton = findViewById(R.id.btn_forget)
        statusText = findViewById(R.id.tv_status)
        messageInput = findViewById(R.id.et_message)
        sendButton = findViewById(R.id.btn_send)
        logText = findViewById(R.id.tv_log)

        joinButton.setOnClickListener { onJoinClicked() }
        sendButton.setOnClickListener { onSendClicked() }
        forgetButton.setOnClickListener { onForgetClicked() }

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
                startEngine(identity, saved.serverUrl, saved.workspaceId, saved.ownerDeviceId, workspaceKey)
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
                startEngine(identity, serverUrl, joined.workspace.id, joined.workspace.ownerDeviceId, workspaceKey)
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
        localState.clear()
        pairingCodeInput.setText("")
        logText.text = ""
        setStatus("Forgot this device. Enter a fresh pairing code to join again.")
        if (currentEngine != null) {
            background.execute { currentEngine.stop() }
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
        background.shutdown()
    }
}
