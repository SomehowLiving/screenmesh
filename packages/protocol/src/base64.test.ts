import { describe, expect, it } from "vitest";
import { base64FromUrlSafe, base64ToUrlSafe, fromBase64, toBase64 } from "./base64.js";

describe("toBase64 / fromBase64", () => {
  it("round-trips empty input", () => {
    expect(fromBase64(toBase64(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it("round-trips arbitrary bytes, including 0x00 and 0xFF", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("round-trips input larger than the 0x8000 chunking boundary", () => {
    // toBase64 processes input in 0x8000-byte chunks via String.fromCharCode(...chunk) —
    // a bug there (e.g. an off-by-one at the boundary) would corrupt exactly the bytes
    // straddling chunk edges, which a small input could never expose.
    const bytes = new Uint8Array(0x8000 * 2 + 137);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("produces standard (non-URL-safe) base64", () => {
    // Bytes chosen so the output is known to contain '+' and '/'.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const b64 = toBase64(bytes);
    expect(b64).toBe("+/+/");
  });
});

describe("base64ToUrlSafe / base64FromUrlSafe", () => {
  it("round-trips standard base64 containing +, /, and padding", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00]);
    const standard = toBase64(bytes);
    expect(standard).toContain("+");
    const urlSafe = base64ToUrlSafe(standard);
    expect(urlSafe).not.toContain("+");
    expect(urlSafe).not.toContain("/");
    expect(urlSafe).not.toContain("=");
    expect(base64FromUrlSafe(urlSafe)).toBe(standard);
    expect(fromBase64(base64FromUrlSafe(urlSafe))).toEqual(bytes);
  });

  it("restores the correct padding length regardless of input length mod 4", () => {
    // "SM1.…" pairing codes round-trip a workspace key through exactly this path
    // (packages/crypto/src/pairing.ts) — wrong padding here breaks pairing entirely.
    for (const byteLength of [1, 2, 3, 4, 5, 16, 32]) {
      const bytes = new Uint8Array(byteLength).map((_, i) => i);
      const roundTripped = fromBase64(base64FromUrlSafe(base64ToUrlSafe(toBase64(bytes))));
      expect(roundTripped).toEqual(bytes);
    }
  });
});
