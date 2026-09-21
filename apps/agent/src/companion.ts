import os from "node:os";
import type { Readable, Writable } from "node:stream";
import { getLanSession, sendLanEnvelope, setLanConnectedDeviceHandler, setLanEnvelopeHandler, startLanSession, stopLanSession, type LanSessionInfo } from "./lan.js";

/** A non-sensitive description of a local route, intentionally excluding MAC and IPv6 addresses. */
export interface CompanionNetworkInterface {
  name: string;
  address: string;
  kind: "wifi" | "ethernet" | "vpn" | "virtual" | "other";
  /** Heuristic only: this is a sensible first bind candidate, not a reachability probe. */
  recommended: boolean;
}

export type CompanionRequest =
  | { type: "screenmesh.listNetworkInterfaces" }
  | { type: "screenmesh.startLanSession"; address: string; sessionId: string; sessionToken: string; expiresAt: number; allowUnsafeRoute?: boolean }
  | { type: "screenmesh.stopLanSession"; sessionId?: string }
  | { type: "screenmesh.getLanSession" }
  | { type: "screenmesh.sendLanEnvelope"; recipientDeviceId: string; envelopeB64: string };

export type CompanionResponse =
  | { ok: true; interfaces: CompanionNetworkInterface[] }
  | { ok: true; session: LanSessionInfo | null }
  | { ok: true; stopped: boolean }
  | { ok: true; sent: boolean }
  | { ok: false; error: string };

export type CompanionEvent =
  | { type: "screenmesh.lan.envelope"; sourceDeviceId: string; envelopeB64: string }
  | { type: "screenmesh.lan.connected"; deviceId: string };

const VPN_NAME_PATTERN = /vpn|pritunl|tailscale|zerotier|wireguard|openvpn|nordlynx|tap|tun\d|ppp|utun/i;
const VIRTUAL_NAME_PATTERN = /virtual|vethernet|hyper-v|wsl|docker|loopback|vmware|vbox/i;
const WIFI_NAME_PATTERN = /wi-?fi|wireless|wlan|airport/i;
const ETHERNET_NAME_PATTERN = /ethernet|\beth\b|en\d/i;

export function interfaceKind(name: string): CompanionNetworkInterface["kind"] {
  if (VPN_NAME_PATTERN.test(name)) return "vpn";
  if (VIRTUAL_NAME_PATTERN.test(name)) return "virtual";
  if (WIFI_NAME_PATTERN.test(name)) return "wifi";
  if (ETHERNET_NAME_PATTERN.test(name)) return "ethernet";
  return "other";
}

const ROUTE_PRIORITY: Record<CompanionNetworkInterface["kind"], number> = {
  wifi: 0,
  ethernet: 1,
  other: 2,
  vpn: 3,
  virtual: 4,
};

function isPrivateLanAddress(address: string): boolean {
  return address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/**
 * The companion is the only ScreenMesh component allowed to read adapter
 * names/addresses. A normal hosted PWA must obtain this data through the
 * browser extension bridge, never by probing a user's network itself.
 */
export function listCompanionNetworkInterfaces(): CompanionNetworkInterface[] {
  const interfaces: CompanionNetworkInterface[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      interfaces.push({ name, address: entry.address, kind: interfaceKind(name), recommended: false });
    }
  }

  interfaces.sort((a, b) => {
    const privateDifference = Number(!isPrivateLanAddress(a.address)) - Number(!isPrivateLanAddress(b.address));
    return privateDifference || ROUTE_PRIORITY[a.kind] - ROUTE_PRIORITY[b.kind] || a.name.localeCompare(b.name);
  });
  if (interfaces[0]) interfaces[0].recommended = true;
  return interfaces;
}

export async function handleCompanionRequest(message: unknown): Promise<CompanionResponse> {
  if (!message || typeof message !== "object") return { ok: false, error: "Unsupported ScreenMesh Companion request." };
  const request = message as Partial<CompanionRequest>;
  try {
    switch (request.type) {
      case "screenmesh.listNetworkInterfaces":
        return { ok: true, interfaces: listCompanionNetworkInterfaces() };
      case "screenmesh.getLanSession":
        return { ok: true, session: getLanSession() };
      case "screenmesh.stopLanSession":
        return { ok: true, stopped: await stopLanSession(request.sessionId) };
      case "screenmesh.sendLanEnvelope": {
        if (typeof request.recipientDeviceId !== "string" || typeof request.envelopeB64 !== "string") return { ok: false, error: "Invalid LAN envelope request." };
        const bytes = Buffer.from(request.envelopeB64, "base64");
        if (bytes.length === 0 || bytes.length > 1024 * 1024) return { ok: false, error: "Invalid LAN envelope request." };
        return { ok: true, sent: sendLanEnvelope(request.recipientDeviceId, bytes) };
      }
      case "screenmesh.startLanSession":
        if (typeof request.address !== "string" || typeof request.sessionId !== "string" || typeof request.sessionToken !== "string" || typeof request.expiresAt !== "number") {
          return { ok: false, error: "Invalid LAN session request." };
        }
        return { ok: true, session: await startLanSession({
          address: request.address,
          sessionId: request.sessionId,
          sessionToken: request.sessionToken,
          expiresAt: request.expiresAt,
          ...(request.allowUnsafeRoute === true ? { allowUnsafeRoute: true } : {}),
        }) };
      default:
        return { ok: false, error: "Unsupported ScreenMesh Companion request." };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not manage the LAN session." };
  }
}

function writeNativeMessage(output: Writable, message: CompanionResponse | CompanionEvent): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  output.write(Buffer.concat([header, body]));
}

/**
 * Chrome Native Messaging host entry point. It speaks the length-prefixed
 * stdio protocol and never logs to stdout: stdout is reserved for responses.
 */
export function startCompanionNativeHost(input: Readable, output: Writable): void {
  let buffered = Buffer.alloc(0);
  let queued = Promise.resolve();
  setLanEnvelopeHandler((sourceDeviceId, data) => {
    writeNativeMessage(output, {
      type: "screenmesh.lan.envelope",
      sourceDeviceId,
      envelopeB64: Buffer.from(data).toString("base64"),
    });
  });
  setLanConnectedDeviceHandler((deviceId) => writeNativeMessage(output, { type: "screenmesh.lan.connected", deviceId }));
  input.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    queued = queued.then(async () => {
      while (buffered.length >= 4) {
      const messageLength = buffered.readUInt32LE(0);
      if (messageLength > 1024 * 1024) {
        writeNativeMessage(output, { ok: false, error: "Companion request is too large." });
        buffered = Buffer.alloc(0);
        return;
      }
      if (buffered.length < 4 + messageLength) return;
      const raw = buffered.subarray(4, 4 + messageLength).toString("utf8");
      buffered = buffered.subarray(4 + messageLength);
        try {
          writeNativeMessage(output, await handleCompanionRequest(JSON.parse(raw) as unknown));
        } catch {
          writeNativeMessage(output, { ok: false, error: "Invalid Companion request." });
        }
      }
    }).catch(() => undefined);
  });
  // The listener exists only while an approved extension holds this native
  // connection. Do not leave a LAN port behind if Chrome disconnects it.
  input.once("end", () => {
    setLanEnvelopeHandler(null);
    setLanConnectedDeviceHandler(null);
    void stopLanSession();
  });
}
