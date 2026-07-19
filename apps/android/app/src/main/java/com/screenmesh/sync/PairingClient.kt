package com.screenmesh.sync

import com.screenmesh.crypto.DeviceIdentity
import com.screenmesh.crypto.exportEncryptionPublicKey
import com.screenmesh.crypto.exportPublicKey
import com.screenmesh.protocol.DeviceInfo
import com.screenmesh.protocol.DeviceTypes
import com.screenmesh.protocol.JoinWorkspaceRequest
import com.screenmesh.protocol.JoinWorkspaceResponse
import com.screenmesh.protocol.RotatePairingRequest
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
private val httpClient = OkHttpClient()

/**
 * Kotlin mirror of apps/agent/src/join.ts's joinWorkspace (the HTTP half
 * of it — pairing-code decoding is a separate call to
 * com.screenmesh.crypto.decodePairingPayload). POSTs this device's
 * DeviceInfo plus the pairing token redeemed from the QR code to the
 * relay's join endpoint. See apps/server/src/workspaces.ts for the
 * server side of this contract.
 */
fun joinWorkspaceHttp(
    serverUrl: String,
    workspaceId: String,
    pairingToken: String,
    identity: DeviceIdentity,
    deviceName: String,
): JoinWorkspaceResponse {
    val device = DeviceInfo(
        id = identity.deviceId,
        name = deviceName,
        publicKey = exportPublicKey(identity.publicKey),
        encryptionKey = exportEncryptionPublicKey(identity.encryptionPublicKey),
        type = DeviceTypes.PHONE,
        capabilities = null,
    )
    val body = Json.encodeToString(
        JoinWorkspaceRequest.serializer(),
        JoinWorkspaceRequest(pairingToken = pairingToken, device = device),
    )
    val request = Request.Builder()
        .url("$serverUrl/workspaces/$workspaceId/join")
        .post(body.toRequestBody(JSON_MEDIA_TYPE))
        .build()
    httpClient.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
            throw Exception("POST ${request.url} -> ${response.code} ${response.body?.string()}")
        }
        val text = response.body?.string() ?: throw Exception("empty join response")
        return Json.decodeFromString(JoinWorkspaceResponse.serializer(), text)
    }
}

/**
 * Kotlin mirror of the pairing-token half of the desktop web app's own
 * invite flow (POST /workspaces/:id/pairing-token — owner-only; the
 * server rejects this unless `callerDeviceId` matches the workspace's
 * ownerDeviceId). Used by the "advertise via BLE" nearby-pairing flow in
 * MainActivity: mint a fresh single-use token server-side, then serve the
 * resulting pairing code over BleTransport.localPairingCode so a nearby
 * scanner can read and redeem it via [joinWorkspaceHttp] exactly like a
 * QR/NFC code.
 */
fun rotatePairingTokenHttp(
    serverUrl: String,
    workspaceId: String,
    callerDeviceId: String,
    pairingToken: String,
    tokenExpiresAt: Long,
) {
    val body = Json.encodeToString(
        RotatePairingRequest.serializer(),
        RotatePairingRequest(deviceId = callerDeviceId, pairingToken = pairingToken, tokenExpiresAt = tokenExpiresAt),
    )
    val request = Request.Builder()
        .url("$serverUrl/workspaces/$workspaceId/pairing-token")
        .post(body.toRequestBody(JSON_MEDIA_TYPE))
        .build()
    httpClient.newCall(request).execute().use { response ->
        if (!response.isSuccessful) {
            throw Exception("POST ${request.url} -> ${response.code} ${response.body?.string()}")
        }
    }
}
