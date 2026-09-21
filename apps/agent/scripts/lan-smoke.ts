import { createHash, randomUUID, X509Certificate } from "node:crypto";
import tls from "node:tls";
import { getLanSession, sendLanEnvelope, setLanDisconnectedDeviceHandler, setLanEnvelopeHandler, startLanSession, stopLanSession } from "../src/lan.js";
import { listCompanionNetworkInterfaces } from "../src/companion.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function connect(address: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    socket.once("secureConnect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readLine(socket: tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("timed out waiting for LAN listener response")), 2_000);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end >= 0) {
        clearTimeout(timeout);
        resolve(text.slice(0, end));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

const route = listCompanionNetworkInterfaces().find((candidate) => candidate.kind !== "vpn" && candidate.kind !== "virtual");
if (!route) {
  console.log("LAN SMOKE SKIPPED (no safe non-loopback IPv4 route on this machine)");
  process.exit(0);
}

const sessionId = randomUUID();
const sessionToken = randomUUID();
const deviceId = randomUUID();
const session = await startLanSession({
  address: route.address,
  sessionId,
  sessionToken,
  expiresAt: Date.now() + 60_000,
});

try {
  assert(session.address === route.address, "listener must bind the requested route");
  assert(session.port > 0, "listener must receive a random TCP port");
  assert(session.certificateSha256.startsWith("sha256/"), "listener must provide an SPKI pin");

  const socket = await connect(session.address, session.port);
  const certificate = socket.getPeerCertificate(true);
  assert(certificate.raw, "TLS peer must present a certificate");
  const spki = new X509Certificate(certificate.raw).publicKey.export({ type: "spki", format: "der" });
  const observedPin = `sha256/${createHash("sha256").update(spki).digest("base64")}`;
  assert(observedPin === session.certificateSha256, "TLS peer certificate must match the advertised pin");
  socket.write(`${JSON.stringify({ type: "screenmesh.lan.hello", sessionToken, deviceId })}\n`);
  const ready = JSON.parse(await readLine(socket)) as { type?: string; sessionId?: string };
  assert(ready.type === "screenmesh.lan.ready" && ready.sessionId === sessionId, "valid one-use token must authenticate the client");
  assert(getLanSession()?.status === "connected", "successful handshake must update listener status");

  const inbound = new Promise<Uint8Array>((resolve) => setLanEnvelopeHandler((_source, data) => resolve(data)));
  const fromPhone = new TextEncoder().encode('{"opaque":"android-envelope"}');
  socket.write(`${JSON.stringify({ type: "screenmesh.lan.envelope", envelopeB64: Buffer.from(fromPhone).toString("base64") })}\n`);
  assert(new TextDecoder().decode(await inbound) === new TextDecoder().decode(fromPhone), "companion must emit opaque Android envelope bytes");

  const toPhone = new TextEncoder().encode('{"opaque":"desktop-envelope"}');
  const outbound = readLine(socket).then((line) => JSON.parse(line) as { type?: string; envelopeB64?: string });
  assert(sendLanEnvelope(deviceId, toPhone), "companion must target only the authenticated Android identity");
  const frame = await outbound;
  assert(frame.type === "screenmesh.lan.envelope" && frame.envelopeB64 === Buffer.from(toPhone).toString("base64"), "companion must forward opaque desktop envelope bytes");
  assert(!sendLanEnvelope(randomUUID(), toPhone), "companion must reject a different recipient identity");
  const disconnected = new Promise<{ deviceId: string; reason: string }>((resolve) => {
    setLanDisconnectedDeviceHandler((lostDeviceId, reason) => resolve({ deviceId: lostDeviceId, reason }));
  });
  socket.destroy();
  const routeLoss = await disconnected;
  assert(routeLoss.deviceId === deviceId && routeLoss.reason === "android-disconnected", "closing Android TLS must report route loss for fallback");
  assert(getLanSession()?.status === "disconnected", "a closed authenticated socket must no longer be advertised as a direct route");

  const replay = await connect(session.address, session.port);
  replay.write(`${JSON.stringify({ type: "screenmesh.lan.hello", sessionToken })}\n`);
  const replayClosed = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 1_000);
    replay.once("close", () => { clearTimeout(timeout); resolve(true); });
    replay.once("error", () => { clearTimeout(timeout); resolve(true); });
  });
  assert(replayClosed, "a consumed session token must not be accepted again");
} finally {
  setLanEnvelopeHandler(null);
  setLanDisconnectedDeviceHandler(null);
  await stopLanSession(sessionId);
}

assert(getLanSession() === null, "stopping must release the selected-interface listener");
console.log(`LAN SMOKE OK (${session.address}:${session.port}, TLS pin verified, token single-use)`);
