import { describe, expect, it } from "vitest";
import { WorkspaceRegistry, isRegistryError } from "./registry.js";
import type { CreateWorkspaceRequest, DeviceInfo, JoinWorkspaceRequest } from "@screenmesh/protocol";

const alwaysOffline = () => false;

function device(id: string, name = id): DeviceInfo {
  return { id, name, publicKey: `pub-${id}`, type: "desktop" };
}

function createReq(overrides: Partial<CreateWorkspaceRequest> = {}): CreateWorkspaceRequest {
  return {
    workspace: { id: "ws-1", name: "Test Workspace", createdAt: Date.now() },
    device: device("owner"),
    pairingToken: "token-1",
    tokenExpiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("WorkspaceRegistry.create", () => {
  it("creates a workspace with the creating device as owner", () => {
    const registry = new WorkspaceRegistry();
    const err = registry.create(createReq());
    expect(err).toBeNull();
    expect(registry.deviceIds("ws-1")).toEqual(["owner"]);
  });

  it("rejects creating a workspace with an id that already exists", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const err = registry.create(createReq());
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(409);
  });
});

describe("WorkspaceRegistry.join", () => {
  function setup() {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    return registry;
  }

  function joinReq(overrides: Partial<JoinWorkspaceRequest> = {}): JoinWorkspaceRequest {
    return { pairingToken: "token-1", device: device("joiner"), ...overrides };
  }

  it("rejects joining an unknown workspace", () => {
    const registry = new WorkspaceRegistry();
    const result = registry.join("no-such-workspace", joinReq(), alwaysOffline);
    expect(isRegistryError(result)).toBe(true);
    expect((result as { code: number }).code).toBe(404);
  });

  it("rejects a wrong pairing token", () => {
    const registry = setup();
    const result = registry.join("ws-1", joinReq({ pairingToken: "wrong-token" }), alwaysOffline);
    expect(isRegistryError(result)).toBe(true);
    expect((result as { code: number }).code).toBe(403);
  });

  it("rejects an expired pairing token", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq({ tokenExpiresAt: Date.now() - 1000 }));
    const result = registry.join("ws-1", joinReq(), alwaysOffline);
    expect(isRegistryError(result)).toBe(true);
    expect((result as { code: number }).code).toBe(403);
  });

  it("accepts a valid pairing token and adds the joining device", () => {
    const registry = setup();
    const result = registry.join("ws-1", joinReq(), alwaysOffline);
    expect(isRegistryError(result)).toBe(false);
    expect(registry.deviceIds("ws-1").sort()).toEqual(["joiner", "owner"]);
  });

  it("rejects reusing an already-consumed (single-use) pairing token", () => {
    const registry = setup();
    registry.join("ws-1", joinReq(), alwaysOffline);
    const second = registry.join("ws-1", joinReq({ device: device("second-joiner") }), alwaysOffline);
    expect(isRegistryError(second)).toBe(true);
    expect((second as { code: number }).code).toBe(403);
  });

  it("rejects joining an expired workspace even with a valid token", () => {
    const registry = new WorkspaceRegistry();
    registry.create({
      ...createReq(),
      workspace: { id: "ws-1", name: "Test", createdAt: Date.now() - 10_000, expiresAt: Date.now() - 1 },
    });
    const result = registry.join("ws-1", joinReq(), alwaysOffline);
    expect(isRegistryError(result)).toBe(true);
    expect((result as { code: number }).code).toBe(410);
  });

  it("a fresh pairing token issued after one is consumed allows a second device to join", () => {
    const registry = setup();
    registry.join("ws-1", joinReq(), alwaysOffline);
    registry.rotatePairing("ws-1", "owner", "token-2", Date.now() + 60_000, "rotation-nonce-0001");
    const result = registry.join(
      "ws-1",
      joinReq({ pairingToken: "token-2", device: device("second-joiner") }),
      alwaysOffline,
    );
    expect(isRegistryError(result)).toBe(false);
    expect(registry.deviceIds("ws-1").sort()).toEqual(["joiner", "owner", "second-joiner"]);
  });
});

describe("WorkspaceRegistry.rotatePairing", () => {
  it("rejects rotation from a non-owner device", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const err = registry.rotatePairing("ws-1", "not-the-owner", "token-2", Date.now() + 60_000, "rotation-nonce-0002");
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(403);
  });

  it("rejects rotation for an unknown workspace", () => {
    const registry = new WorkspaceRegistry();
    const err = registry.rotatePairing("no-such-workspace", "owner", "token-2", Date.now() + 60_000, "rotation-nonce-0003");
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(404);
  });

  it("rejects reusing a signed-request nonce after a rotation", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const nonce = "rotation-nonce-0004";
    expect(registry.rotatePairing("ws-1", "owner", "token-2", Date.now() + 60_000, nonce)).toBeNull();
    const err = registry.rotatePairing("ws-1", "owner", "token-3", Date.now() + 60_000, nonce);
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(409);
  });
});

describe("WorkspaceRegistry.removeDevice", () => {
  function setupWithJoinedDevice() {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    registry.join("ws-1", { pairingToken: "token-1", device: device("joiner") }, alwaysOffline);
    return registry;
  }

  it("owner can remove a joined device", () => {
    const registry = setupWithJoinedDevice();
    const err = registry.removeDevice("ws-1", "owner", "joiner");
    expect(err).toBeNull();
    expect(registry.deviceIds("ws-1")).toEqual(["owner"]);
  });

  it("rejects removal requested by a non-owner", () => {
    const registry = setupWithJoinedDevice();
    const err = registry.removeDevice("ws-1", "joiner", "owner");
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(403);
  });

  it("rejects the owner revoking itself", () => {
    const registry = setupWithJoinedDevice();
    const err = registry.removeDevice("ws-1", "owner", "owner");
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(400);
  });

  it("rejects removing a device that isn't in the workspace", () => {
    const registry = setupWithJoinedDevice();
    const err = registry.removeDevice("ws-1", "owner", "never-joined");
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(404);
  });
});

describe("WorkspaceRegistry.presence / setCapabilities", () => {
  it("reports online status per the provided isOnline predicate", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const presence = registry.presence("ws-1", (id) => id === "owner");
    expect(presence).toHaveLength(1);
    expect(presence[0]?.online).toBe(true);
  });

  it("setCapabilities updates what a device advertises, reflected in presence", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const err = registry.setCapabilities("ws-1", "owner", ["camera", "terminal"]);
    expect(err).toBeNull();
    const presence = registry.presence("ws-1", alwaysOffline);
    expect(presence[0]?.capabilities).toEqual(["camera", "terminal"]);
  });

  it("rejects setCapabilities for a device not in the workspace", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    const err = registry.setCapabilities("ws-1", "ghost", ["camera"]);
    expect(isRegistryError(err)).toBe(true);
    expect(err?.code).toBe(404);
  });
});

describe("WorkspaceRegistry.workspaceExpired", () => {
  it("is false for a workspace with no expiry", () => {
    const registry = new WorkspaceRegistry();
    registry.create(createReq());
    expect(registry.workspaceExpired("ws-1")).toBe(false);
  });

  it("is true once past an explicit expiry", () => {
    const registry = new WorkspaceRegistry();
    registry.create({
      ...createReq(),
      workspace: { id: "ws-1", name: "Test", createdAt: Date.now(), expiresAt: Date.now() - 1 },
    });
    expect(registry.workspaceExpired("ws-1")).toBe(true);
  });

  it("is false for an unknown workspace (no throw)", () => {
    const registry = new WorkspaceRegistry();
    expect(registry.workspaceExpired("no-such-workspace")).toBe(false);
  });
});
