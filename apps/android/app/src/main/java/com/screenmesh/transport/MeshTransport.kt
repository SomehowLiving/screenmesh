package com.screenmesh.transport

/**
 * Kotlin mirror of packages/transport/src/transport.ts. Adapters carry
 * opaque ciphertext (SecureEnvelope bytes) — never plaintext. Unlike the
 * protocol-package types, TransportKind/TransportStatus/Peer are never
 * serialized onto the wire (they're local discovery/UI bookkeeping only),
 * so plain Kotlin enums are safe here — no risk of a string-format
 * mismatch with the TS side the way there would be for wire types.
 */
enum class TransportKind {
    WEBRTC,
    WEBSOCKET_RELAY,
    QR,
    NEARBY,
    LAN,
    LOCAL_P2P,
}

enum class TransportStatus {
    IDLE,
    DISCOVERING,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    ERROR,
}

data class Peer(
    val deviceId: String,
    val name: String,
    /** Which transport discovered this peer. */
    val transport: TransportKind,
)

data class Connection(val peer: Peer, val close: () -> Unit)

interface MeshTransport {
    val kind: TransportKind

    fun discover(): List<Peer>
    fun connect(peer: Peer): Connection
    fun send(data: ByteArray)
    fun disconnect()

    fun onMessage(handler: (ByteArray) -> Unit)
    fun onStatusChange(handler: (TransportStatus) -> Unit)
}
