import { describe, expect, it } from "vitest";
import { toBase64 } from "@screenmesh/protocol";
import {
  createPairingPayload,
  decodePairingPayload,
  encodePairingPayload,
  isPairingExpired,
  randomId,
} from "./pairing.js";

describe("randomId", () => {
  it("produces distinct, URL-safe identifiers", () => {
    const a = randomId();
    const b = randomId();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
  });
});

describe("createPairingPayload / encodePairingPayload / decodePairingPayload", () => {
  it("round-trips a payload through the compact SM1.… wire format", () => {
    const workspaceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const now = 1_700_000_000_000;
    const payload = createPairingPayload({ workspaceId: "ws-1", workspaceKey, now });

    const encoded = encodePairingPayload(payload);
    expect(encoded.startsWith("SM1.")).toBe(true);

    const decoded = decodePairingPayload(encoded);
    expect(decoded).toEqual(payload);
  });

  it("does not encode serverUrl into the wire format (join-response-provided, not QR-carried)", () => {
    const workspaceKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const payload = createPairingPayload({
      workspaceId: "ws-1",
      workspaceKey,
      serverUrl: "https://example.test",
      now: Date.now(),
    });
    const encoded = encodePairingPayload(payload);
    expect(encoded).not.toContain("example.test");
    // decodePairingPayload can't recover serverUrl either — it's not on the wire.
    expect(decodePairingPayload(encoded).serverUrl).toBeUndefined();
  });

  it("round-trips an SM2 local-companion invitation without putting the relay URL in the QR", () => {
    const payload = createPairingPayload({
      workspaceId: "ws-1",
      workspaceKey: "a2V5",
      serverUrl: "https://relay.example.test",
      now: 1_700_000_000_000,
    });
    const withLan = {
      ...payload,
      lanEndpoint: {
        address: "192.168.1.42",
        port: 54321,
        certificateSha256: `sha256/${toBase64(new Uint8Array(32).fill(7))}`,
        sessionId: randomId(),
        sessionToken: randomId(),
      },
    };
    const encoded = encodePairingPayload(withLan);
    expect(encoded.startsWith("SM2.")).toBe(true);
    expect(encoded).not.toContain("relay.example.test");
    expect(decodePairingPayload(encoded)).toEqual({ ...withLan, serverUrl: undefined });
  });

  it("rejects malformed SM2 local endpoint fields", () => {
    expect(() => decodePairingPayload("SM2.ws.tok.a2V5.1.999-1-1-1.1.bad.id.id")).toThrow(/invalid/);
  });

  it("keeps the SM2 wire format byte-for-byte compatible with Android", () => {
    expect(encodePairingPayload({
      workspaceId: "ws-1",
      pairingToken: "abcdefghijklmnop",
      workspaceKey: "a2V5",
      expiresAt: 1_700_000_000_000,
      lanEndpoint: {
        address: "192.168.1.42",
        port: 54321,
        certificateSha256: `sha256/${toBase64(new Uint8Array(32).fill(7))}`,
        sessionId: "abcdefghijklmnop",
        sessionToken: "qrstuvwxyzABCDEF",
      },
    })).toBe("SM2.ws-1.abcdefghijklmnop.a2V5.loyw3v28.192-168-1-42.15wx.BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc.abcdefghijklmnop.qrstuvwxyzABCDEF");
  });

  it("applies the default 5-minute TTL when none is given", () => {
    const now = 1_700_000_000_000;
    const payload = createPairingPayload({ workspaceId: "ws-1", workspaceKey: "a2V5", now });
    expect(payload.expiresAt).toBe(now + 5 * 60 * 1000);
  });

  it("honors an explicit ttlMs", () => {
    const now = 1_700_000_000_000;
    const payload = createPairingPayload({
      workspaceId: "ws-1",
      workspaceKey: "a2V5",
      now,
      ttlMs: 30_000,
    });
    expect(payload.expiresAt).toBe(now + 30_000);
  });

  it("round-trips a workspaceKey containing +, /, and padding-sensitive lengths", () => {
    // Exercises base64ToUrlSafe/base64FromUrlSafe end to end through the real
    // pairing code, not just in isolation (see packages/protocol/base64.test.ts).
    for (const byteLength of [15, 16, 17, 32]) {
      const workspaceKey = toBase64(new Uint8Array(byteLength).map((_, i) => (i * 37) % 256));
      const payload = createPairingPayload({ workspaceId: "ws-1", workspaceKey, now: Date.now() });
      const decoded = decodePairingPayload(encodePairingPayload(payload));
      expect(decoded.workspaceKey).toBe(workspaceKey);
    }
  });

  it("rejects a code with the wrong prefix", () => {
    expect(() => decodePairingPayload("XX2.ws.tok.a2V5.1")).toThrow(/invalid pairing code/);
  });

  it("rejects a code with the wrong number of segments", () => {
    expect(() => decodePairingPayload("SM1.ws.tok.a2V5")).toThrow(/invalid pairing code/);
  });

  it("rejects a code with an empty required segment", () => {
    expect(() => decodePairingPayload("SM1..tok.a2V5.1")).toThrow(/invalid pairing code/);
  });
});

describe("isPairingExpired", () => {
  it("is false strictly before expiresAt and true at/after it", () => {
    const payload = createPairingPayload({ workspaceId: "ws-1", workspaceKey: "a2V5", now: 1000 });
    expect(isPairingExpired(payload, payload.expiresAt - 1)).toBe(false);
    expect(isPairingExpired(payload, payload.expiresAt)).toBe(true);
    expect(isPairingExpired(payload, payload.expiresAt + 1)).toBe(true);
  });
});
