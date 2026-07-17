package com.screenmesh

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.screenmesh.crypto.decodePairingPayload
import com.screenmesh.crypto.generateIdentity
import com.screenmesh.crypto.importWorkspaceKey
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.sync.EngineConfig
import com.screenmesh.sync.MeshEngine
import com.screenmesh.sync.joinWorkspaceHttp
import com.screenmesh.transport.RelayAuth
import com.screenmesh.transport.RelayTransport
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Minimal reference UI (classic Views, no Compose) exercising MeshEngine
 * end to end against a real relay: join a workspace from a pairing code,
 * then send/receive plain text objects. This is intentionally bare — a
 * proof that the ported protocol/crypto/transport/sync stack actually
 * talks to the same relay the web PWA and desktop agent use, not a
 * finished app UI. See docs/Android.md.
 */
class MainActivity : AppCompatActivity() {
    private val background: ExecutorService = Executors.newSingleThreadExecutor()
    private var engine: MeshEngine? = null

    private lateinit var serverUrlInput: EditText
    private lateinit var pairingCodeInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var joinButton: Button
    private lateinit var statusText: TextView
    private lateinit var messageInput: EditText
    private lateinit var sendButton: Button
    private lateinit var logText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        serverUrlInput = findViewById(R.id.et_server_url)
        pairingCodeInput = findViewById(R.id.et_pairing_code)
        deviceNameInput = findViewById(R.id.et_device_name)
        joinButton = findViewById(R.id.btn_join)
        statusText = findViewById(R.id.tv_status)
        messageInput = findViewById(R.id.et_message)
        sendButton = findViewById(R.id.btn_send)
        logText = findViewById(R.id.tv_log)

        joinButton.setOnClickListener { onJoinClicked() }
        sendButton.setOnClickListener { onSendClicked() }
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
                val relayWsUrl = Regex("^http").replaceFirst(serverUrl, "ws") + "/relay"

                val auth = object : RelayAuth {
                    override val deviceId = identity.deviceId
                    override val workspaceId = joined.workspace.id
                    override fun sign(data: ByteArray): ByteArray = com.screenmesh.crypto.sign(identity, data)
                }
                val transport = RelayTransport(relayWsUrl, auth)
                val newEngine = MeshEngine(
                    EngineConfig(
                        identity = identity,
                        workspaceId = joined.workspace.id,
                        workspaceKey = workspaceKey,
                        ownerDeviceId = joined.workspace.ownerDeviceId,
                        transport = transport,
                        onObjectReceived = { obj, senderId ->
                            appendLog("Received from $senderId: ${obj.content}")
                        },
                    ),
                )
                engine = newEngine
                newEngine.start()
                runOnUiThread { setStatus("Joined \"${joined.workspace.name}\" as $deviceName") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Join failed: ${e.message}") }
            }
        }
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
