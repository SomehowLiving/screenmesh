package com.screenmesh.sync

import android.content.Context
import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.exportEd25519PrivateKey
import com.screenmesh.crypto.exportEncryptionPrivateKey
import com.screenmesh.crypto.exportEncryptionPublicKey
import com.screenmesh.crypto.exportPublicKey
import com.screenmesh.crypto.importEd25519PrivateKey
import com.screenmesh.crypto.importEncryptionPrivateKey
import com.screenmesh.crypto.importEncryptionPublicKey
import com.screenmesh.crypto.importPublicKey
import com.screenmesh.protocol.Delivery
import com.screenmesh.protocol.Device
import com.screenmesh.protocol.MeshObject
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private const val PREFS_NAME = "screenmesh_state"
private const val KEY_STATE = "state_json"
private const val KEY_ENGINE_PREFIX = "engine_json_"

/**
 * JSON-serializable form of a DeviceIdentity — Kotlin mirror of
 * packages/crypto/src/persist.ts's SerializedIdentity. Only meaningful
 * because every BC key-parameter object is effectively "extractable"
 * (there's no Android equivalent of Web Crypto's non-extractable
 * CryptoKey — see Identity.kt's module doc comment).
 */
@Serializable
data class SerializedIdentity(
    val deviceId: String,
    val publicKeyB64: String,
    val privateKeyB64: String,
    val encryptionPublicKeyB64: String,
    val encryptionPrivateKeyB64: String,
)

fun DeviceIdentity.serialize(): SerializedIdentity = SerializedIdentity(
    deviceId = deviceId,
    publicKeyB64 = exportPublicKey(publicKey),
    privateKeyB64 = exportEd25519PrivateKey(privateKey),
    encryptionPublicKeyB64 = exportEncryptionPublicKey(encryptionPublicKey),
    encryptionPrivateKeyB64 = exportEncryptionPrivateKey(encryptionPrivateKey),
)

fun SerializedIdentity.toDeviceIdentity(): DeviceIdentity = DeviceIdentity(
    deviceId = deviceId,
    publicKey = importPublicKey(publicKeyB64),
    privateKey = importEd25519PrivateKey(privateKeyB64),
    encryptionPublicKey = importEncryptionPublicKey(encryptionPublicKeyB64),
    encryptionPrivateKey = importEncryptionPrivateKey(encryptionPrivateKeyB64),
)

/**
 * Everything the app needs to resume without re-pairing — Kotlin mirror
 * of apps/agent/src/state.ts's AgentState. Deliberately NOT the full
 * local database (objects, deliveries, ratchet sessions) — MeshEngine.kt
 * keeps those in memory only and they're lost on restart regardless,
 * which is fine: a lost ratchet session just re-bootstraps from the
 * identity keys + pairing secret here, exactly as the ratchet design
 * intends (docs/Security.md §5). Losing the DEVICE IDENTITY would force
 * re-pairing (a new pairing token, minted from the web app), which is
 * the one thing actually worth persisting.
 */
@Serializable
data class AppState(
    val identity: SerializedIdentity,
    val deviceName: String,
    val workspaceId: String,
    val ownerDeviceId: String,
    val serverUrl: String,
    /** Raw AES pairing secret, base64 — same format as PairingPayload.workspaceKey. */
    val workspaceKeyB64: String,
)

/**
 * SharedPreferences-backed persistence — the Android equivalent of the
 * desktop agent's JSON-file-on-disk state (apps/agent/src/state.ts).
 * SharedPreferences already lives in per-app private storage, so no
 * extra file-permission hardening is needed the way the Node agent's
 * plain JSON file does.
 */
class LocalStateStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): AppState? {
        val raw = prefs.getString(KEY_STATE, null) ?: return null
        return try {
            Json.decodeFromString(AppState.serializer(), raw)
        } catch (_: Exception) {
            null
        }
    }

    fun save(state: AppState) {
        prefs.edit().putString(KEY_STATE, Json.encodeToString(AppState.serializer(), state)).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_STATE).apply()
    }
}

@Serializable
data class PersistedOutboxEntry(
    val bundleId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val encryptedPayloadB64: String,
    val createdAt: Long,
    val expiresAt: Long,
    val hopLimit: Int,
    val offeredTo: List<String> = emptyList(),
)

@Serializable
data class PersistedDeliveryBundle(
    val bundleId: String,
    val sourceDeviceId: String,
    val destinationDeviceId: String,
    val workspaceId: String,
    val encryptedPayloadB64: String,
    val createdAt: Long,
    val expiresAt: Long,
    val hopLimit: Int,
    val signatureB64: String,
    val offeredTo: List<String>? = null,
)

@Serializable
data class EngineState(
    val seq: Int = 0,
    val objects: List<MeshObject> = emptyList(),
    val deliveries: List<Delivery> = emptyList(),
    val devices: List<Device> = emptyList(),
    val seenAt: Map<String, Long> = emptyMap(),
    val outbox: List<PersistedOutboxEntry> = emptyList(),
    val carried: List<PersistedDeliveryBundle> = emptyList(),
)

interface EngineStateStore {
    fun load(workspaceId: String, deviceId: String): EngineState?
    fun save(workspaceId: String, deviceId: String, state: EngineState)
    fun clear(workspaceId: String, deviceId: String)
}

class LocalEngineStateStore(context: Context) : EngineStateStore {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(workspaceId: String, deviceId: String): EngineState? {
        val raw = prefs.getString(key(workspaceId, deviceId), null) ?: return null
        return try {
            Json.decodeFromString(EngineState.serializer(), raw)
        } catch (_: Exception) {
            null
        }
    }

    override fun save(workspaceId: String, deviceId: String, state: EngineState) {
        prefs.edit().putString(key(workspaceId, deviceId), Json.encodeToString(EngineState.serializer(), state)).apply()
    }

    override fun clear(workspaceId: String, deviceId: String) {
        prefs.edit().remove(key(workspaceId, deviceId)).apply()
    }

    private fun key(workspaceId: String, deviceId: String): String = "$KEY_ENGINE_PREFIX$workspaceId:$deviceId"
}
