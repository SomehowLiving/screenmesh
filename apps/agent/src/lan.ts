import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import type { Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { generate } from "selfsigned";
import { listCompanionNetworkInterfaces, type CompanionNetworkInterface } from "./companion.js";

const MAX_LAN_SESSION_MS = 5 * 60_000;
const MAX_HANDSHAKE_BYTES = 4 * 1024;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_FAILED_ATTEMPTS_PER_MINUTE = 5;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export interface LanSessionInfo {
  sessionId: string;
  address: string;
  port: number;
  /** `sha256/<base64>` SPKI pin. A future native client must verify this. */
  certificateSha256: string;
  expiresAt: number;
  status: "listening" | "connected";
}

interface ActiveLanSession extends LanSessionInfo {
  server: tls.Server;
  tokenHash: Buffer;
  timer: NodeJS.Timeout;
  sockets: Set<TLSSocket>;
  rawSockets: Set<Socket>;
  failedAttempts: Map<string, { count: number; startedAt: number }>;
  consumed: boolean;
  remoteDeviceId: string | null;
  remoteSocket: TLSSocket | null;
}

let activeSession: ActiveLanSession | null = null;
let inboundEnvelopeHandler: ((sourceDeviceId: string, data: Uint8Array) => void) | null = null;
let connectedDeviceHandler: ((deviceId: string) => void) | null = null;

/** Installed only by the Native Messaging host; envelopes are already E2E encrypted. */
export function setLanEnvelopeHandler(handler: ((sourceDeviceId: string, data: Uint8Array) => void) | null): void {
  inboundEnvelopeHandler = handler;
}

export function setLanConnectedDeviceHandler(handler: ((deviceId: string) => void) | null): void {
  connectedDeviceHandler = handler;
}

function privateIpv4(address: string): boolean {
  return address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function requiresExplicitRiskAcceptance(route: CompanionNetworkInterface): boolean {
  return !privateIpv4(route.address) || route.kind === "vpn" || route.kind === "virtual";
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function tokenMatches(expectedHash: Buffer, received: unknown): boolean {
  if (typeof received !== "string" || !ID_PATTERN.test(received)) return false;
  const actualHash = hashToken(received);
  return timingSafeEqual(expectedHash, actualHash);
}

function safeRemoteAddress(socket: TLSSocket): string {
  return socket.remoteAddress ?? "unknown";
}

function allowAttempt(session: ActiveLanSession, remoteAddress: string): boolean {
  const now = Date.now();
  const prior = session.failedAttempts.get(remoteAddress);
  if (!prior || now - prior.startedAt >= 60_000) {
    session.failedAttempts.set(remoteAddress, { count: 0, startedAt: now });
    return true;
  }
  return prior.count < MAX_FAILED_ATTEMPTS_PER_MINUTE;
}

function recordFailedAttempt(session: ActiveLanSession, remoteAddress: string): void {
  const now = Date.now();
  const prior = session.failedAttempts.get(remoteAddress);
  if (!prior || now - prior.startedAt >= 60_000) {
    session.failedAttempts.set(remoteAddress, { count: 1, startedAt: now });
  } else {
    prior.count += 1;
  }
}

function closeSocket(socket: TLSSocket): void {
  socket.end();
  socket.destroy();
}

function decodeEnvelope(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_ENVELOPE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= MAX_ENVELOPE_BYTES ? bytes : null;
}

function attachEnvelopeStream(session: ActiveLanSession, socket: TLSSocket, initial = ""): void {
  let buffered = initial;
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (Buffer.byteLength(buffered, "utf8") > MAX_ENVELOPE_BYTES * 2) return closeSocket(socket);
    let lineEnd = buffered.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 1);
      try {
        const frame = JSON.parse(line) as { type?: unknown; envelopeB64?: unknown };
        const envelope = frame.type === "screenmesh.lan.envelope" ? decodeEnvelope(frame.envelopeB64) : null;
        if (!envelope || !session.remoteDeviceId) return closeSocket(socket);
        inboundEnvelopeHandler?.(session.remoteDeviceId, envelope);
      } catch {
        return closeSocket(socket);
      }
      lineEnd = buffered.indexOf("\n");
    }
  };
  socket.on("data", onData);
}

function attachHandshake(session: ActiveLanSession, socket: TLSSocket): void {
  session.sockets.add(socket);
  socket.setTimeout(10_000, () => closeSocket(socket));
  socket.once("close", () => session.sockets.delete(socket));
  socket.once("error", () => undefined);

  const remoteAddress = safeRemoteAddress(socket);
  if (!allowAttempt(session, remoteAddress)) {
    closeSocket(socket);
    return;
  }

  let buffered = "";
  const reject = () => {
    recordFailedAttempt(session, remoteAddress);
    closeSocket(socket);
  };
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (Buffer.byteLength(buffered, "utf8") > MAX_HANDSHAKE_BYTES) return reject();
    const lineEnd = buffered.indexOf("\n");
    if (lineEnd < 0) return;
    socket.off("data", onData);
    try {
      const request = JSON.parse(buffered.slice(0, lineEnd)) as { type?: unknown; sessionToken?: unknown; deviceId?: unknown };
      if (session.consumed || request.type !== "screenmesh.lan.hello" || !tokenMatches(session.tokenHash, request.sessionToken) || typeof request.deviceId !== "string" || !ID_PATTERN.test(request.deviceId)) {
        return reject();
      }
      // The one-time token authorizes one native client. Future data transport
      // will run only after this point, as opaque SecureEnvelope bytes.
      session.status = "connected";
      session.consumed = true;
      session.tokenHash.fill(0);
      session.remoteDeviceId = request.deviceId;
      session.remoteSocket = socket;
      connectedDeviceHandler?.(request.deviceId);
      socket.setTimeout(0);
      socket.write(`${JSON.stringify({ type: "screenmesh.lan.ready", sessionId: session.sessionId })}\n`);
      attachEnvelopeStream(session, socket, buffered.slice(lineEnd + 1));
    } catch {
      reject();
    }
  };
  socket.on("data", onData);
}

/**
 * Starts a temporary, TLS-protected LAN listener on exactly one selected
 * interface. It never uses 0.0.0.0 and it keeps only a SHA-256 token hash.
 * This is a pairing bootstrap listener, not a plaintext or envelope transport.
 */
export async function startLanSession(params: {
  address: string;
  sessionId: string;
  sessionToken: string;
  expiresAt: number;
  allowUnsafeRoute?: boolean;
}): Promise<LanSessionInfo> {
  if (activeSession) throw new Error("A ScreenMesh LAN pairing session is already active.");
  if (!ID_PATTERN.test(params.sessionId) || !ID_PATTERN.test(params.sessionToken)) {
    throw new Error("LAN session identifiers must be strong URL-safe random values.");
  }
  const now = Date.now();
  if (!Number.isSafeInteger(params.expiresAt) || params.expiresAt <= now || params.expiresAt > now + MAX_LAN_SESSION_MS) {
    throw new Error("LAN session expiry must be within the next five minutes.");
  }
  const route = listCompanionNetworkInterfaces().find((candidate) => candidate.address === params.address);
  if (!route) throw new Error("The requested address is not an active local IPv4 interface.");
  if (requiresExplicitRiskAcceptance(route) && !params.allowUnsafeRoute) {
    throw new Error("VPN, virtual, and non-private routes require explicit confirmation.");
  }

  const certificate = await generate(
    [{ name: "commonName", value: "ScreenMesh Local Companion" }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now - 1_000),
      notAfterDate: new Date(params.expiresAt + 60_000),
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: route.address }] },
      ],
    },
  );
  const spki = new X509Certificate(certificate.cert).publicKey.export({ type: "spki", format: "der" });
  const certificateSha256 = `sha256/${createHash("sha256").update(spki).digest("base64")}`;
  // Android's supported minimum includes API 26, where TLS 1.3 is not
  // universal. TLS 1.2+ plus a QR-pinned ephemeral SPKI remains authenticated.
  const server = tls.createServer({ key: certificate.private, cert: certificate.cert, minVersion: "TLSv1.2" });
  // A pairing listener accepts one intended device, not an unbounded LAN load.
  server.maxConnections = 8;

  const session = {
    sessionId: params.sessionId,
    address: route.address,
    port: 0,
    certificateSha256,
    expiresAt: params.expiresAt,
    status: "listening" as const,
    server,
    tokenHash: hashToken(params.sessionToken),
    timer: undefined as unknown as NodeJS.Timeout,
    sockets: new Set<TLSSocket>(),
    rawSockets: new Set<Socket>(),
    failedAttempts: new Map<string, { count: number; startedAt: number }>(),
    consumed: false,
    remoteDeviceId: null,
    remoteSocket: null,
  } satisfies ActiveLanSession;
  server.on("connection", (socket) => {
    session.rawSockets.add(socket);
    socket.once("close", () => session.rawSockets.delete(socket));
  });
  server.on("secureConnection", (socket) => attachHandshake(session, socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: route.address, port: 0, exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("LAN listener did not receive a TCP port."));
      session.port = address.port;
      resolve();
    });
  }).catch((error: unknown) => {
    server.close();
    throw error;
  });
  session.timer = setTimeout(() => { void stopLanSession(session.sessionId); }, params.expiresAt - now);
  session.timer.unref();
  activeSession = session;
  return sessionInfo(session);
}

function sessionInfo(session: ActiveLanSession): LanSessionInfo {
  const { sessionId, address, port, certificateSha256, expiresAt, status } = session;
  return { sessionId, address, port, certificateSha256, expiresAt, status };
}

export function getLanSession(): LanSessionInfo | null {
  return activeSession ? sessionInfo(activeSession) : null;
}

/** Sends an opaque envelope only to the one Android identity that consumed this session. */
export function sendLanEnvelope(recipientDeviceId: string, data: Uint8Array): boolean {
  const session = activeSession;
  const socket = session?.remoteSocket;
  if (!session || !socket || socket.destroyed || session.remoteDeviceId !== recipientDeviceId || data.length === 0 || data.length > MAX_ENVELOPE_BYTES) return false;
  socket.write(`${JSON.stringify({ type: "screenmesh.lan.envelope", envelopeB64: Buffer.from(data).toString("base64") })}\n`);
  return true;
}

export async function stopLanSession(sessionId?: string): Promise<boolean> {
  const session = activeSession;
  if (!session || (sessionId && session.sessionId !== sessionId)) return false;
  activeSession = null;
  clearTimeout(session.timer);
  for (const socket of session.sockets) closeSocket(socket);
  // TLS connections that have not completed their handshake are not in
  // `sockets` yet. Destroy them too so stop/expiry cannot be held open.
  for (const socket of session.rawSockets) socket.destroy();
  session.tokenHash.fill(0);
  session.remoteSocket = null;
  session.remoteDeviceId = null;
  await new Promise<void>((resolve) => session.server.close(() => resolve()));
  return true;
}
