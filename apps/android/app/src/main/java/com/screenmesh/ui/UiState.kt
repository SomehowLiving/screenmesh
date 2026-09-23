package com.screenmesh.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import com.screenmesh.protocol.Device

enum class Screen { Onboarding, Workspace, Devices, Pair }

/**
 * Everything the Compose UI observes. MainActivity owns one instance and
 * writes to it (always via runOnUiThread — Compose state must be mutated on
 * the main thread, same discipline the old View-based UI used for
 * statusText/logText.append). Composables only ever read it and call back
 * into MainActivity through [ScreenMeshActions].
 */
class ScreenMeshUiState {
    var screen by mutableStateOf(Screen.Onboarding)

    // Onboarding fields
    var deviceName by mutableStateOf("")
    var serverUrl by mutableStateOf("")
    var pairingCodeField by mutableStateOf("")
    var advancedExpanded by mutableStateOf(false)

    // Joined-session info
    var workspaceLabel by mutableStateOf<String?>(null)
    var devices by mutableStateOf<List<Device>>(emptyList())

    // Workspace composer + feed
    var messageText by mutableStateOf("")
    var logLines by mutableStateOf<List<String>>(emptyList())

    // Pair screen
    var mintedCode by mutableStateOf<String?>(null)
    var mintedQr by mutableStateOf<ImageBitmap?>(null)
    var pairBusy by mutableStateOf(false)

    // Shared
    var status by mutableStateOf("")
    var busy by mutableStateOf(false)
}

/** Every user-triggered action the UI can invoke — all run on MainActivity's background executor. */
data class ScreenMeshActions(
    val onJoin: () -> Unit,
    val onSend: () -> Unit,
    val onForget: () -> Unit,
    val onScanBle: () -> Unit,
    val onAdvertiseBle: () -> Unit,
    val onNfcWrite: () -> Unit,
    val onWifiDirectScan: () -> Unit,
    val onAcousticInitiator: () -> Unit,
    val onAcousticResponder: () -> Unit,
    val onMintPairCode: () -> Unit,
    val onCopyToClipboard: (String) -> Unit,
)
