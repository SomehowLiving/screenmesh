package com.screenmesh.sync

import android.content.Context
import com.screenmesh.protocol.FileChunkMeta
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Durable buffer for in-progress incoming file-chunk reassembly, backed by
 * one small file per chunk on disk — not routed through EngineStateStore's
 * single SharedPreferences blob (see LocalState.kt's EngineState). A
 * chunked file can total tens of megabytes; rewriting one ever-growing
 * string on every single chunk would turn an N-chunk transfer into an
 * effectively O(N^2) amount of I/O. Kotlin mirror of the web engine's
 * `fileChunks` Dexie table (packages/storage/src/db.ts) — same purpose,
 * different storage primitive to fit Android's persistence model.
 *
 * Optional, like EngineStateStore: pass a `chunkStore` in EngineConfig to
 * enable it. Without one, incoming chunks stay in-memory only, same as
 * before this reliability pass.
 */
class FileChunkStore(context: Context) {
    private val root = File(context.filesDir, "file_chunks")

    private fun dir(fileId: String) = File(root, fileId)

    fun saveChunk(fileId: String, chunkIndex: Int, totalChunks: Int, dataB64: String, meta: FileChunkMeta?) {
        val d = dir(fileId)
        d.mkdirs()
        File(d, "$chunkIndex.b64").writeText(dataB64)
        File(d, "total.txt").writeText(totalChunks.toString())
        if (meta != null) {
            File(d, "meta.json").writeText(Json.encodeToString(FileChunkMeta.serializer(), meta))
        }
    }

    fun chunkIndexes(fileId: String): Set<Int> {
        val files = dir(fileId).listFiles { f -> f.name.endsWith(".b64") } ?: return emptySet()
        return files.mapNotNull { it.name.removeSuffix(".b64").toIntOrNull() }.toSet()
    }

    fun readChunk(fileId: String, chunkIndex: Int): String? =
        File(dir(fileId), "$chunkIndex.b64").takeIf { it.isFile }?.readText()

    fun readTotal(fileId: String): Int? =
        File(dir(fileId), "total.txt").takeIf { it.isFile }?.readText()?.toIntOrNull()

    fun readMeta(fileId: String): FileChunkMeta? {
        val f = File(dir(fileId), "meta.json")
        if (!f.isFile) return null
        return try {
            Json.decodeFromString(FileChunkMeta.serializer(), f.readText())
        } catch (_: Exception) {
            null
        }
    }

    /** All file IDs with any in-progress reassembly buffered on disk — read at startup to rehydrate. */
    fun inProgressFileIds(): List<String> = root.listFiles { f -> f.isDirectory }?.map { it.name } ?: emptyList()

    /** Called once a file finishes reassembling (or is abandoned) to free the buffer. */
    fun deleteFile(fileId: String) {
        dir(fileId).deleteRecursively()
    }
}
