import os from "node:os";
import type { Readable, Writable } from "node:stream";

/** A non-sensitive description of a local route, intentionally excluding MAC and IPv6 addresses. */
export interface CompanionNetworkInterface {
  name: string;
  address: string;
  kind: "wifi" | "ethernet" | "vpn" | "virtual" | "other";
  /** Heuristic only: this is a sensible first bind candidate, not a reachability probe. */
  recommended: boolean;
}

export type CompanionRequest = { type: "screenmesh.listNetworkInterfaces" };

export type CompanionResponse =
  | { ok: true; interfaces: CompanionNetworkInterface[] }
  | { ok: false; error: string };

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

export function handleCompanionRequest(message: unknown): CompanionResponse {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "screenmesh.listNetworkInterfaces") {
    return { ok: false, error: "Unsupported ScreenMesh Companion request." };
  }
  return { ok: true, interfaces: listCompanionNetworkInterfaces() };
}

function writeNativeMessage(output: Writable, message: CompanionResponse): void {
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
  input.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
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
        writeNativeMessage(output, handleCompanionRequest(JSON.parse(raw) as unknown));
      } catch {
        writeNativeMessage(output, { ok: false, error: "Invalid Companion request." });
      }
    }
  });
}
