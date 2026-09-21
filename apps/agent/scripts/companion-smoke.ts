import { PassThrough } from "node:stream";
import {
  handleCompanionRequest,
  interfaceKind,
  listCompanionNetworkInterfaces,
  startCompanionNativeHost,
} from "../src/companion.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

const interfaces = listCompanionNetworkInterfaces();
assert(interfaces.every((entry) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry.address)), "only IPv4 addresses are exposed");
assert(interfaces.every((entry) => entry.name.length > 0), "every route has a name");
assert(interfaces.filter((entry) => entry.recommended).length <= 1, "at most one route is recommended");
assert(interfaceKind("Tailscale Tunnel") === "vpn", "VPN adapters should be classified before generic routes");
assert(interfaceKind("Docker Desktop") === "virtual", "Docker adapters should be classified as virtual");
assert(interfaceKind("Wi-Fi") === "wifi", "Wi-Fi adapters should be classified");

const accepted = handleCompanionRequest({ type: "screenmesh.listNetworkInterfaces" });
assert(accepted.ok, "the list request should be accepted");
const rejected = handleCompanionRequest({ type: "anything-else" });
assert(!rejected.ok, "unknown requests must be rejected");

const input = new PassThrough();
const output = new PassThrough();
let nativeResponse = Buffer.alloc(0);
output.on("data", (chunk: Buffer) => {
  nativeResponse = Buffer.concat([nativeResponse, chunk]);
});
startCompanionNativeHost(input, output);
const requestBody = Buffer.from(JSON.stringify({ type: "screenmesh.listNetworkInterfaces" }));
const requestHeader = Buffer.allocUnsafe(4);
requestHeader.writeUInt32LE(requestBody.length, 0);
input.write(Buffer.concat([requestHeader, requestBody]));
await new Promise<void>((resolve) => setImmediate(resolve));
const responseSize = nativeResponse.readUInt32LE(0);
const response = JSON.parse(nativeResponse.subarray(4, 4 + responseSize).toString("utf8")) as { ok?: boolean };
assert(response.ok, "the native host must return a framed successful response");

console.log(`COMPANION SMOKE OK (${interfaces.length} local IPv4 route(s))`);
