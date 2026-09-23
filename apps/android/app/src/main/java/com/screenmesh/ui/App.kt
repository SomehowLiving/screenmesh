package com.screenmesh.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.screenmesh.protocol.Device
import com.screenmesh.protocol.DeviceCapabilities
import com.screenmesh.protocol.MeshObjectTypes
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenMeshApp(state: ScreenMeshUiState, actions: ScreenMeshActions) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.workspaceLabel ?: "ScreenMesh") },
                actions = {
                    if (state.screen != Screen.Onboarding) {
                        TextButton(onClick = actions.onForget) { Text("Forget") }
                    }
                },
            )
        },
        bottomBar = {
            if (state.screen != Screen.Onboarding) {
                NavigationBar {
                    NavigationBarItem(
                        selected = state.screen == Screen.Workspace,
                        onClick = { state.screen = Screen.Workspace },
                        icon = { Icon(Icons.Filled.Forum, contentDescription = null) },
                        label = { Text("Workspace") },
                    )
                    NavigationBarItem(
                        selected = state.screen == Screen.Feed,
                        onClick = { state.screen = Screen.Feed },
                        icon = { Icon(Icons.Filled.Inbox, contentDescription = null) },
                        label = { Text("Library") },
                    )
                    NavigationBarItem(
                        selected = state.screen == Screen.Devices,
                        onClick = { state.screen = Screen.Devices },
                        icon = { Icon(Icons.Filled.Devices, contentDescription = null) },
                        label = { Text("Devices (${state.devices.size})") },
                    )
                    NavigationBarItem(
                        selected = state.screen == Screen.Pair,
                        onClick = {
                            state.screen = Screen.Pair
                            if (state.mintedCode == null) actions.onMintPairCode()
                        },
                        icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                        label = { Text("Pair device") },
                    )
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (state.status.isNotBlank()) {
                Text(
                    state.status,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            when (state.screen) {
                Screen.Onboarding -> OnboardingScreen(state, actions)
                Screen.Workspace -> WorkspaceScreen(state, actions)
                Screen.Feed -> {
                    // Delivery status (chunk-ack progress, stall retries, expiry
                    // sweeps) advances in the background with no push callback
                    // into the UI, unlike devices (onDevicesChanged) or new
                    // objects (appended straight to state) — poll while this
                    // tab is visible so it doesn't look frozen.
                    LaunchedEffect(Unit) {
                        while (true) {
                            actions.onRefreshFeed()
                            delay(2000)
                        }
                    }
                    FeedScreen(state, actions)
                }
                Screen.Devices -> DevicesScreen(state)
                Screen.Pair -> PairScreen(state, actions)
            }
        }
    }
}

@Composable
private fun OnboardingScreen(state: ScreenMeshUiState, actions: ScreenMeshActions) {
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        // decodePairingPayload accepts either a bare "SM1./SM2." code or a
        // full "<origin>/#join=<code>" join URL — whatever the QR encodes —
        // so the scanned text can be dropped straight into the same field
        // pasting uses, no separate parsing needed here.
        result.contents?.let { state.pairingCodeField = it }
    }
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Join a workspace", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "Pair this phone with a ScreenMesh workspace created on another device.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
        )
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = { state.deviceName = it },
            label = { Text("This device's name") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.serverUrl,
            onValueChange = { state.serverUrl = it },
            label = { Text("Relay server URL") },
            placeholder = { Text("http://192.168.1.23:8787/api") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.pairingCodeField,
            onValueChange = { state.pairingCodeField = it },
            label = { Text("Pairing code (from the web app's QR / join link)") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
            maxLines = 4,
        )
        OutlinedButton(
            onClick = {
                scanLauncher.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt("Point the camera at the pairing QR code")
                        .setBeepEnabled(false)
                        .setOrientationLocked(false),
                )
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Filled.QrCodeScanner, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Scan QR code")
        }
        Button(
            onClick = actions.onJoin,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), color = MaterialTheme.colorScheme.onPrimary)
            else Text("Join workspace")
        }

        Spacer(Modifier.height(4.dp))
        AdvancedTransportsSection(
            expanded = state.advancedExpanded,
            onToggle = { state.advancedExpanded = !state.advancedExpanded },
            actions = actions,
            mode = AdvancedMode.FillPairingCode,
        )
    }
}

@Composable
private fun WorkspaceScreen(state: ScreenMeshUiState, actions: ScreenMeshActions) {
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri?.let { actions.onAttachFile(it) }
    }
    var optionsExpanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(16.dp),
            reverseLayout = true,
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.Bottom),
        ) {
            if (state.logLines.isEmpty()) {
                item {
                    Text(
                        "Nothing sent or received yet. Objects you send or receive across the mesh will show up here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(top = 40.dp),
                    )
                }
            }
            items(state.logLines.asReversed()) { line ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Text(line, modifier = Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .padding(12.dp),
        ) {
            TextButton(onClick = { optionsExpanded = !optionsExpanded }) {
                Text(
                    if (optionsExpanded) "Hide options" else "Type: ${COMPOSER_TYPES.first { it.first == state.composerType }.second}${state.targetCapability?.let { " · $it" } ?: ""}",
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            if (optionsExpanded) {
                ComposerOptions(state)
            }
            if (state.composerType == MeshObjectTypes.AGENT_TASK) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(
                        value = state.taskAction,
                        onValueChange = { state.taskAction = it },
                        label = { Text("Action (e.g. echo, read_file, run_command)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = state.taskParams,
                        onValueChange = { state.taskParams = it },
                        label = { Text("Params as JSON, e.g. {\"command\": \"pnpm test\"}") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 1,
                        maxLines = 3,
                    )
                    Button(
                        onClick = actions.onSend,
                        enabled = !state.busy && state.taskAction.isNotBlank(),
                        modifier = Modifier.align(Alignment.End),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Send task")
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (state.composerType == MeshObjectTypes.DOCUMENT) {
                        OutlinedTextField(
                            value = state.documentTitle,
                            onValueChange = { state.documentTitle = it },
                            label = { Text("Title (optional)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                        )
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        IconButton(onClick = { filePicker.launch("*/*") }, enabled = !state.busy) {
                            Icon(Icons.Filled.AttachFile, contentDescription = "Attach a file or image")
                        }
                        OutlinedTextField(
                            value = state.messageText,
                            onValueChange = { state.messageText = it },
                            placeholder = {
                                Text(
                                    if (state.composerType == MeshObjectTypes.CHECKLIST) "One checklist item per line…"
                                    else "Type a note to send here…",
                                )
                            },
                            modifier = Modifier.weight(1f),
                            minLines = 1,
                            maxLines = 4,
                        )
                        IconButton(onClick = actions.onSend, enabled = !state.busy && state.messageText.isNotBlank()) {
                            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComposerOptions(state: ScreenMeshUiState) {
    Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            var typeMenuOpen by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(expanded = typeMenuOpen, onExpandedChange = { typeMenuOpen = it }, modifier = Modifier.weight(1f)) {
                OutlinedTextField(
                    value = COMPOSER_TYPES.first { it.first == state.composerType }.second,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Type") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = typeMenuOpen) },
                    modifier = Modifier.menuAnchor().fillMaxWidth(),
                )
                ExposedDropdownMenu(expanded = typeMenuOpen, onDismissRequest = { typeMenuOpen = false }) {
                    COMPOSER_TYPES.forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(label) }, onClick = { state.composerType = value; typeMenuOpen = false })
                    }
                }
            }
            var expiryMenuOpen by remember { mutableStateOf(false) }
            ExposedDropdownMenuBox(expanded = expiryMenuOpen, onExpandedChange = { expiryMenuOpen = it }, modifier = Modifier.weight(1f)) {
                OutlinedTextField(
                    value = EXPIRY_CHOICES[state.expiryIndex].first,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Expiry") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expiryMenuOpen) },
                    modifier = Modifier.menuAnchor().fillMaxWidth(),
                )
                ExposedDropdownMenu(expanded = expiryMenuOpen, onDismissRequest = { expiryMenuOpen = false }) {
                    EXPIRY_CHOICES.forEachIndexed { index, (label, _) ->
                        DropdownMenuItem(text = { Text(label) }, onClick = { state.expiryIndex = index; expiryMenuOpen = false })
                    }
                }
            }
        }
        var targetMenuOpen by remember { mutableStateOf(false) }
        val targetOptions = listOf<String?>(null) + DEVICE_CAPABILITIES
        ExposedDropdownMenuBox(expanded = targetMenuOpen, onExpandedChange = { targetMenuOpen = it }) {
            OutlinedTextField(
                value = state.targetCapability ?: "Everyone",
                onValueChange = {},
                readOnly = true,
                label = { Text("Send to") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = targetMenuOpen) },
                modifier = Modifier.menuAnchor().fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = targetMenuOpen, onDismissRequest = { targetMenuOpen = false }) {
                targetOptions.forEach { capability ->
                    DropdownMenuItem(
                        text = { Text(capability ?: "Everyone") },
                        onClick = { state.targetCapability = capability; targetMenuOpen = false },
                    )
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = state.deleteAfterOpening, onCheckedChange = { state.deleteAfterOpening = it })
            Text("Delete after opening", style = MaterialTheme.typography.bodySmall)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = state.requireConfirmation, onCheckedChange = { state.requireConfirmation = it })
            Text("Require recipient to accept", style = MaterialTheme.typography.bodySmall)
        }
    }
}

private val DEVICE_CAPABILITIES = listOf(
    DeviceCapabilities.TERMINAL,
    DeviceCapabilities.FILESYSTEM,
    DeviceCapabilities.CAMERA,
    DeviceCapabilities.MICROPHONE,
    DeviceCapabilities.GPS,
    DeviceCapabilities.BROWSER,
    DeviceCapabilities.LOCAL_MODELS,
)

@Composable
private fun DevicesScreen(state: ScreenMeshUiState) {
    if (state.devices.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                "No other devices paired into this workspace yet.\nTap \"Pair device\" to invite one.",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(state.devices, key = { it.id }) { device -> DeviceRow(device) }
    }
}

@Composable
private fun DeviceRow(device: Device) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(10.dp)
                    .background(if (device.status == "online") Color(0xFF2FB344) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f), CircleShape),
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(device.name, fontWeight = FontWeight.Medium)
                Text(
                    "${device.type} · ${if (device.status == "online") "Online" else "Offline"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
        }
    }
}

@Composable
private fun PairScreen(state: ScreenMeshUiState, actions: ScreenMeshActions) {
    Column(
        Modifier.fillMaxSize().padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Invite a device", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "Show this to another device, or have it scan/paste the code below. It expires in 5 minutes and is single-use.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            textAlign = TextAlign.Center,
        )

        val qr = state.mintedQr
        Box(
            Modifier
                .fillMaxWidth(0.7f)
                .aspectRatio(1f)
                .background(Color.White, RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            when {
                state.pairBusy -> CircularProgressIndicator()
                qr != null -> Image(bitmap = qr, contentDescription = "Pairing QR code", modifier = Modifier.fillMaxSize().padding(16.dp))
                else -> Text("No code yet", color = Color.Gray)
            }
        }

        val code = state.mintedCode
        if (code != null) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                Text(
                    code,
                    modifier = Modifier.padding(12.dp),
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { actions.onCopyToClipboard(code) }) { Text("Copy code") }
                OutlinedButton(onClick = actions.onMintPairCode) { Text("New code") }
            }
        } else if (!state.pairBusy) {
            Button(onClick = actions.onMintPairCode) { Text("Generate pairing code") }
        }

        Spacer(Modifier.height(8.dp))
        AdvancedTransportsSection(
            expanded = state.advancedExpanded,
            onToggle = { state.advancedExpanded = !state.advancedExpanded },
            actions = actions,
            mode = AdvancedMode.BroadcastMintedCode,
        )
    }
}

private enum class AdvancedMode { FillPairingCode, BroadcastMintedCode }

/**
 * BLE / NFC / Wi-Fi Direct / acoustic — all four are experimental and
 * UNTESTED on real hardware (see MainActivity's doc comment), so they stay
 * available but tucked behind an explicit expand instead of competing with
 * the relay-based flow that's actually known to work.
 */
@Composable
private fun AdvancedTransportsSection(
    expanded: Boolean,
    onToggle: () -> Unit,
    actions: ScreenMeshActions,
    mode: AdvancedMode,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Advanced: nearby transports (experimental, untested)",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Filled.ExpandMore, contentDescription = null)
        }
        if (expanded) {
            Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (mode) {
                    AdvancedMode.FillPairingCode -> {
                        OutlinedButton(onClick = actions.onScanBle, modifier = Modifier.fillMaxWidth()) { Text("Scan nearby (Bluetooth)") }
                    }
                    AdvancedMode.BroadcastMintedCode -> {
                        OutlinedButton(onClick = actions.onAdvertiseBle, modifier = Modifier.fillMaxWidth()) { Text("Advertise via Bluetooth") }
                        OutlinedButton(onClick = actions.onNfcWrite, modifier = Modifier.fillMaxWidth()) { Text("Write to NFC tag") }
                    }
                }
                Text(
                    "Wi-Fi Direct and acoustic (sound-based) are raw experimental transports, not pairing shortcuts:",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
                OutlinedButton(onClick = actions.onWifiDirectScan, modifier = Modifier.fillMaxWidth()) { Text("Scan nearby (Wi-Fi Direct)") }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = actions.onAcousticInitiator, modifier = Modifier.weight(1f)) { Text("Acoustic: initiator") }
                    OutlinedButton(onClick = actions.onAcousticResponder, modifier = Modifier.weight(1f)) { Text("Acoustic: responder") }
                }
            }
        }
    }
}
