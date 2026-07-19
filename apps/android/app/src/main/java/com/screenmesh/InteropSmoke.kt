package com.screenmesh

import com.screenmesh.crypto.generateIdentity
import com.screenmesh.crypto.importWorkspaceKey
import com.screenmesh.protocol.MeshObjectTypes
import com.screenmesh.sync.EngineConfig
import com.screenmesh.sync.MeshEngine
import com.screenmesh.sync.joinWorkspaceHttp
import com.screenmesh.transport.RelayAuth
import com.screenmesh.transport.RelayTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.system.exitProcess

/**
 * Cross-language interop smoke test — NOT part of the shipped app: no
 * reference from MainActivity or AndroidManifest.xml, so it has zero
 * effect on the APK. This file (and everything it calls — Identity,
 * Ratchet, RelayTransport, MeshEngine, PairingClient) has no Android API
 * dependency, so it's a plain JVM program: compiled by the same
 * `compileDebugKotlin` as the rest of the app, but run directly with
 * `java`, not on a device/emulator (this environment has neither).
 *
 * Proves the hand-ported Kotlin MeshEngine can actually talk to the real
 * TypeScript engine over a live relay — the one thing compiling and
 * linting alone could never prove. Pairs with
 * packages/sync/scripts/interop-with-android.ts (device A, TypeScript,
 * which creates the workspace and writes the handoff file this reads).
 * See docs/Android.md's "Verification status" for the exact commands
 * and classpath.
 *
 * This device (B) reads join info from the handoff file, joins as a
 * fresh device, waits for a greeting object from the TS device, prints
 * it, replies with a text object of its own, then exits.
 */
fun main(args: Array<String>) {
    val handoffPath = args.getOrNull(0) ?: error("usage: InteropSmokeKt <handoff-file-path>")
    val handoff = Json.parseToJsonElement(File(handoffPath).readText()).jsonObject
    val serverUrl = handoff.getValue("serverUrl").jsonPrimitive.content
    val workspaceId = handoff.getValue("workspaceId").jsonPrimitive.content
    val pairingToken = handoff.getValue("pairingToken").jsonPrimitive.content
    val workspaceKeyB64 = handoff.getValue("workspaceKeyB64").jsonPrimitive.content

    println("[1/5] joining workspace $workspaceId as a fresh Kotlin device")
    val identity = generateIdentity()
    val joined = joinWorkspaceHttp(serverUrl, workspaceId, pairingToken, identity, "Kotlin Device B")
    val workspaceKey = importWorkspaceKey(workspaceKeyB64)
    println("[2/5] joined; owner is ${joined.workspace.ownerDeviceId}, my id is ${identity.deviceId}")

    val relayWsUrl = Regex("^http").replaceFirst(serverUrl, "ws") + "/relay"
    val auth = object : RelayAuth {
        override val deviceId = identity.deviceId
        override val workspaceId = workspaceId
        override fun sign(data: ByteArray): ByteArray = com.screenmesh.crypto.sign(identity, data)
    }
    val transport = RelayTransport(relayWsUrl, auth)

    val greetingReceived = CountDownLatch(1)
    val greetingText = AtomicReference<String?>(null)
    val senderId = AtomicReference<String?>(null)

    val engine = MeshEngine(
        EngineConfig(
            identity = identity,
            workspaceId = workspaceId,
            workspaceKey = workspaceKey,
            ownerDeviceId = joined.workspace.ownerDeviceId,
            transport = transport,
            onObjectReceived = { obj, senderDeviceId ->
                val text = obj.content.jsonObject["text"]?.jsonPrimitive?.content
                println("[3/5] received object from $senderDeviceId: \"$text\"")
                senderId.set(senderDeviceId)
                greetingText.set(text)
                greetingReceived.countDown()
            },
        ),
    )
    engine.start()

    if (!greetingReceived.await(90, TimeUnit.SECONDS)) {
        println("KOTLIN INTEROP FAILED: timed out waiting for a greeting from the TS device")
        exitProcess(1)
    }

    val from = senderId.get() ?: run {
        println("KOTLIN INTEROP FAILED: no sender id recorded")
        exitProcess(1)
    }
    val reply = buildJsonObject { put("text", JsonPrimitive("hello from Kotlin")) }
    engine.sendObject(MeshObjectTypes.TEXT, reply, listOf(from))
    println("[4/5] replied to $from")

    // Give the reply time to actually leave over the socket before tearing it down.
    Thread.sleep(2000)
    engine.stop()
    println("[5/5] done")
    println("KOTLIN INTEROP OK")
}
