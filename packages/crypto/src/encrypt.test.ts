import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  exportWorkspaceKey,
  generateWorkspaceKey,
  importWorkspaceKey,
  NONCE_BYTES,
} from "./encrypt.js";

describe("encrypt / decrypt", () => {
  it("round-trips plaintext", async () => {
    const key = await generateWorkspaceKey();
    const plaintext = new TextEncoder().encode("a secret handoff payload");
    const payload = await encrypt(key, plaintext);
    expect(await decrypt(key, payload)).toEqual(plaintext);
  });

  it("uses a fresh nonce per call", async () => {
    const key = await generateWorkspaceKey();
    const plaintext = new TextEncoder().encode("same plaintext twice");
    const a = await encrypt(key, plaintext);
    const b = await encrypt(key, plaintext);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("produces a nonce of NONCE_BYTES length", async () => {
    const key = await generateWorkspaceKey();
    const payload = await encrypt(key, new Uint8Array([1, 2, 3]));
    expect(payload.nonce.length).toBe(NONCE_BYTES);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = await generateWorkspaceKey();
    const wrongKey = await generateWorkspaceKey();
    const payload = await encrypt(key, new TextEncoder().encode("secret"));
    await expect(decrypt(wrongKey, payload)).rejects.toThrow();
  });

  it("fails to decrypt if the ciphertext is tampered with (AES-GCM auth tag check)", async () => {
    const key = await generateWorkspaceKey();
    const payload = await encrypt(key, new TextEncoder().encode("secret"));
    const tampered = new Uint8Array(payload.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(decrypt(key, { nonce: payload.nonce, ciphertext: tampered })).rejects.toThrow();
  });

  it("fails to decrypt if the nonce is wrong", async () => {
    const key = await generateWorkspaceKey();
    const payload = await encrypt(key, new TextEncoder().encode("secret"));
    const wrongNonce = new Uint8Array(payload.nonce);
    wrongNonce[0] = wrongNonce[0]! ^ 0xff;
    await expect(decrypt(key, { nonce: wrongNonce, ciphertext: payload.ciphertext })).rejects.toThrow();
  });
});

describe("exportWorkspaceKey / importWorkspaceKey", () => {
  it("round-trips a key through base64 and still decrypts", async () => {
    const key = await generateWorkspaceKey();
    const reimported = await importWorkspaceKey(await exportWorkspaceKey(key));
    const plaintext = new TextEncoder().encode("shared over the QR channel");
    const payload = await encrypt(key, plaintext);
    expect(await decrypt(reimported, payload)).toEqual(plaintext);
  });
});
