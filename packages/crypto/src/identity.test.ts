import { describe, expect, it } from "vitest";
import {
  exportEd25519PrivateKey,
  exportPublicKey,
  generateIdentity,
  importEd25519PrivateKey,
  importPublicKey,
  sign,
  verify,
} from "./identity.js";

describe("generateIdentity", () => {
  it("gives every identity a distinct deviceId and distinct key material", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(await exportPublicKey(a.publicKey)).not.toBe(await exportPublicKey(b.publicKey));
  });
});

describe("sign / verify", () => {
  it("verifies a signature produced by the matching identity", async () => {
    const identity = await generateIdentity();
    const data = new TextEncoder().encode("hello screenmesh");
    const signature = await sign(identity, data);
    expect(await verify(identity.publicKey, signature, data)).toBe(true);
  });

  it("rejects a signature checked against a different device's public key", async () => {
    const identity = await generateIdentity();
    const impostor = await generateIdentity();
    const data = new TextEncoder().encode("hello screenmesh");
    const signature = await sign(identity, data);
    expect(await verify(impostor.publicKey, signature, data)).toBe(false);
  });

  it("rejects a signature when the signed data has been tampered with", async () => {
    const identity = await generateIdentity();
    const signature = await sign(identity, new TextEncoder().encode("original"));
    expect(await verify(identity.publicKey, signature, new TextEncoder().encode("tampered"))).toBe(
      false,
    );
  });
});

describe("exportPublicKey / importPublicKey", () => {
  it("round-trips a public key through base64 and still verifies signatures", async () => {
    const identity = await generateIdentity();
    const reimported = await importPublicKey(await exportPublicKey(identity.publicKey));
    const data = new TextEncoder().encode("round trip check");
    const signature = await sign(identity, data);
    expect(await verify(reimported, signature, data)).toBe(true);
  });
});

describe("exportEd25519PrivateKey / importEd25519PrivateKey", () => {
  it("round-trips an extractable private key and can still sign with it", async () => {
    // Mirrors the desktop agent's on-disk persistence path (no IndexedDB
    // to lean on) — a bug here would silently corrupt identity on reload.
    const identity = await generateIdentity({ extractable: true });
    const exported = await exportEd25519PrivateKey(identity.privateKey);
    const reimported = await importEd25519PrivateKey(exported);

    const data = new TextEncoder().encode("persisted identity check");
    const signature = await sign({ ...identity, privateKey: reimported }, data);
    expect(await verify(identity.publicKey, signature, data)).toBe(true);
  });
});
