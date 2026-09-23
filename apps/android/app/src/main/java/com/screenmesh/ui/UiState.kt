package com.screenmesh.ui

import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import com.screenmesh.protocol.Delivery
import com.screenmesh.protocol.Device
import com.screenmesh.protocol.FileContent
import com.screenmesh.protocol.MeshObject
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.sync.ObjectLocalState

enum class Screen { Onboarding, Workspace, Feed, Devices, Pair }

/** Composer type choices exposed in the UI — mirrors Send.tsx's TYPE_CHOICES,
 *  minus "document" (needs Yjs, not ported here). */
val COMPOSER_TYPES = listOf(
    MeshObjectTypes.TEXT to "Text",
    MeshObjectTypes.LINK to "Link",
    MeshObjectTypes.CODE to "Code snippet",
    MeshObjectTypes.CHECKLIST to "Checklist (one item per line)",
    MeshObjectTypes.COMMAND to "Command (for a desktop agent)",
    MeshObjectTypes.AGENT_TASK to "Agent task (structured, for a desktop agent)",
)

/** Feed view filters — mirrors Library.tsx's VIEW_FILTERS. */
val FEED_VIEW_FILTERS = listOf("all" to "All", "pinned" to "Pinned", "continue" to "Continue later")

/** Mirrors Send.tsx's EXPIRY_CHOICES. */
val EXPIRY_CHOICES = listOf(
    "Never expires" to null,
    "Expires in 10 minutes" to 10 * 60 * 1000L,
    "Expires in 1 hour" to 60 * 60 * 1000L,
    "Expires in 24 hours" to 24 * 60 * 60 * 1000L,
)

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
    var myDeviceId by mutableStateOf("")
    var workspaceLabel by mutableStateOf<String?>(null)
    var devices by mutableStateOf<List<Device>>(emptyList())

    // Workspace composer
    var messageText by mutableStateOf("")
    var logLines by mutableStateOf<List<String>>(emptyList())
    var composerType by mutableStateOf(MeshObjectTypes.TEXT)
    var expiryIndex by mutableStateOf(0)
    var deleteAfterOpening by mutableStateOf(false)
    var requireConfirmation by mutableStateOf(false)
    /** null = everyone; otherwise a DeviceCapabilities constant — routes via resolveCapability(). */
    var targetCapability by mutableStateOf<String?>(null)
    var taskAction by mutableStateOf("echo")
    var taskParams by mutableStateOf("{}")

    // Feed (Library-lite): every object this device has sent or received
    var objects by mutableStateOf<List<MeshObject>>(emptyList())
    var deliveries by mutableStateOf<List<Delivery>>(emptyList())
    /** Local-only pin/tag/continue-later — never synced, see ObjectLocalStateStore. */
    var objectLocalStates by mutableStateOf<Map<String, ObjectLocalState>>(emptyMap())
    var feedSearch by mutableStateOf("")
    var feedViewFilter by mutableStateOf("all")

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
    /** A file/image picked from the system document picker, to send to everyone in the workspace. */
    val onAttachFile: (Uri) -> Unit,
    val onRefreshFeed: () -> Unit,
    val onAcceptObject: (String) -> Unit,
    val onRejectObject: (String) -> Unit,
    val onMarkOpened: (String) -> Unit,
    val onRetryDelivery: (String) -> Unit,
    /** The user picked a save location (system SAF dialog) for this file's bytes. */
    val onSaveFileToUri: (Uri, FileContent) -> Unit,
    val onTogglePin: (String) -> Unit,
    val onToggleContinueLater: (String) -> Unit,
    val onAddTag: (String, String) -> Unit,
    val onRemoveTag: (String, String) -> Unit,
    /** Hand an object off to another paired device (continueOnDevice). */
    val onContinueOnDevice: (String, String) -> Unit,
)
