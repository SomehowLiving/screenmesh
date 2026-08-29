import { describe, expect, it } from "vitest";
import { envelopeFromJson, envelopeToJson, type SecureEnvelope } from "./envelope.js";

function makeEnvelope(overrides: Partial<SecureEnvelope> = {}): SecureEnvelope {
  return {
    version: 2,
    messageId: "msg-1",
    senderDeviceId: "device-a",
    recipientDeviceId: "device-b",
    workspaceId: "workspace-1",
    createdAt: 1_700_000_000_000,
    sequenceNumber: 3,
    ratchetPublicKeyB64: "cGVlci1yYXRjaGV0LWtleQ==",
    messageNumber: 1,
    previousChainLength: 0,
    ciphertext: new Uint8Array([1, 2, 3, 4, 5]),
    signature: new Uint8Array([9, 8, 7, 6]),
    ...overrides,
  };
}

describe("envelopeToJson / envelopeFromJson", () => {
  it("round-trips every field, including binary ciphertext/signature", () => {
    const env = makeEnvelope();
    const roundTripped = envelopeFromJson(envelopeToJson(env));
    expect(roundTripped).toEqual(env);
  });

  it("omits expiresAt from the JSON form when absent, rather than encoding it as undefined", () => {
    const env = makeEnvelope();
    const json = envelopeToJson(env);
    expect("expiresAt" in json).toBe(false);
    expect(envelopeFromJson(json)).toEqual(env);
  });

  it("round-trips expiresAt when present", () => {
    const env = makeEnvelope({ expiresAt: 1_700_000_500_000 });
    const json = envelopeToJson(env);
    expect(json.expiresAt).toBe(1_700_000_500_000);
    expect(envelopeFromJson(json)).toEqual(env);
  });

  it("encodes ciphertext/signature as base64 strings on the wire", () => {
    const env = makeEnvelope();
    const json = envelopeToJson(env);
    expect(typeof json.ciphertext).toBe("string");
    expect(typeof json.signature).toBe("string");
  });
});
