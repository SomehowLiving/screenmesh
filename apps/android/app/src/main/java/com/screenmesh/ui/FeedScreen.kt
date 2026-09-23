package com.screenmesh.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.screenmesh.protocol.ChecklistContent
import com.screenmesh.protocol.Delivery
import com.screenmesh.protocol.FileContent
import com.screenmesh.protocol.MeshObject
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.protocol.TextContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

/** One object plus this device's view of its delivery state(s) — an object
 *  I sent may have one delivery per recipient; one I received has exactly one. */
private data class FeedRow(val obj: MeshObject, val deliveries: List<Delivery>, val outgoing: Boolean)

private fun buildRows(state: ScreenMeshUiState): List<FeedRow> {
    val byObject = state.deliveries.groupBy { it.objectId }
    return state.objects
        .map { obj -> FeedRow(obj, byObject[obj.id].orEmpty(), outgoing = obj.createdBy == state.myDeviceId) }
        .sortedByDescending { it.obj.updatedAt }
}

private fun deviceName(state: ScreenMeshUiState, deviceId: String): String =
    if (deviceId == state.myDeviceId) "You" else state.devices.find { it.id == deviceId }?.name ?: "Unknown device"

private fun previewFor(obj: MeshObject): String = try {
    when (obj.type) {
        MeshObjectTypes.TEXT, MeshObjectTypes.LINK, MeshObjectTypes.CODE, MeshObjectTypes.COMMAND, MeshObjectTypes.CLIPBOARD ->
            Json.decodeFromJsonElement(TextContent.serializer(), obj.content).text
        MeshObjectTypes.CHECKLIST -> {
            val items = Json.decodeFromJsonElement(ChecklistContent.serializer(), obj.content).items
            "${items.count { it.done }} of ${items.size} tasks complete"
        }
        MeshObjectTypes.FILE, MeshObjectTypes.IMAGE -> {
            val file = Json.decodeFromJsonElement(FileContent.serializer(), obj.content)
            "${file.mimeType} · ${formatSizeForFeed(file.size)}"
        }
        else -> obj.content.jsonObject.toString()
    }
} catch (_: Exception) {
    "(unreadable content)"
}

private fun formatSizeForFeed(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> String.format("%.1f MB", bytes / (1024.0 * 1024.0))
}

@Composable
fun FeedScreen(state: ScreenMeshUiState, actions: ScreenMeshActions) {
    val rows = remember(state.objects, state.deliveries, state.myDeviceId) { buildRows(state) }
    if (rows.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                "Nothing sent or received yet.\nObjects you send or receive across the mesh will show up here.",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(rows, key = { it.obj.id }) { row -> FeedRowCard(row, state, actions) }
    }
}

@Composable
private fun FeedRowCard(row: FeedRow, state: ScreenMeshUiState, actions: ScreenMeshActions) {
    var saveTarget by remember { mutableStateOf<FileContent?>(null) }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri: Uri? ->
        val content = saveTarget
        saveTarget = null
        if (uri != null && content != null) actions.onSaveFileToUri(uri, content)
    }

    val fileContent = if (row.obj.type == MeshObjectTypes.FILE || row.obj.type == MeshObjectTypes.IMAGE) {
        runCatching { Json.decodeFromJsonElement(FileContent.serializer(), row.obj.content) }.getOrNull()
    } else {
        null
    }
    val pendingIncoming = !row.outgoing && row.deliveries.any { it.status == "pending" }
    val failedOutgoing = row.outgoing && row.deliveries.any { it.status == "failed" }
    val statusSummary = if (row.outgoing) {
        row.deliveries.map { "${deviceName(state, it.destinationDeviceId)}: ${it.status}" }.joinToString(", ").ifEmpty { "queued" }
    } else {
        row.deliveries.firstOrNull()?.status ?: "delivered"
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(if (failedOutgoing) Color(0xFFE0453A) else MaterialTheme.colorScheme.primary, CircleShape))
                Text(
                    row.obj.type.replace("_", " ").replaceFirstChar { it.uppercase() },
                    modifier = Modifier.padding(start = 8.dp).weight(1f),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    if (row.outgoing) "To ${row.deliveries.size} device(s)" else "From ${deviceName(state, row.obj.createdBy)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
            }
            Text(previewFor(row.obj), modifier = Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodyMedium)
            Text(
                statusSummary,
                modifier = Modifier.padding(top = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
            )

            val actionsRow = pendingIncoming || failedOutgoing || fileContent != null || (!row.outgoing && row.deliveries.firstOrNull()?.status !in listOf("opened", "pending"))
            if (actionsRow) {
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (pendingIncoming) {
                        Button(onClick = { actions.onAcceptObject(row.obj.id) }) { Text("Accept") }
                        OutlinedButton(onClick = { actions.onRejectObject(row.obj.id) }) { Text("Decline") }
                    } else {
                        if (!row.outgoing && row.deliveries.firstOrNull()?.status != "opened") {
                            OutlinedButton(onClick = { actions.onMarkOpened(row.obj.id) }) { Text("Mark opened") }
                        }
                        if (fileContent != null) {
                            OutlinedButton(onClick = { saveTarget = fileContent; saveLauncher.launch(fileContent.name) }) { Text("Save") }
                        }
                        if (failedOutgoing) {
                            val failedDelivery = row.deliveries.first { it.status == "failed" }
                            OutlinedButton(onClick = { actions.onRetryDelivery(failedDelivery.id) }) { Text("Retry") }
                        }
                    }
                }
            }
        }
    }
}
