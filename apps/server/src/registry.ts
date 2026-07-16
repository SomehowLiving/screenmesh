import type {
  CreateWorkspaceRequest,
  DeviceInfo,
  JoinWorkspaceRequest,
  JoinWorkspaceResponse,
  PresenceEntry,
} from "@screenmesh/protocol";

interface StoredDevice extends DeviceInfo {
  lastSeenAt: number;
}

interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: number;
  expiresAt?: number;
  ownerDeviceId: string;
  devices: Map<string, StoredDevice>;
  /** The current pairing token — single-use, short-lived. */
  pairing: { token: string; expiresAt: number; used: boolean } | null;
}

export interface RegistryError {
  code: number;
  message: string;
}

export function isRegistryError(value: unknown): value is RegistryError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}

/**
 * In-memory workspace + device registry (MVP). The server knows device
 * identities and public keys — metadata, never payloads. Durable storage
 * (PostgreSQL/Redis) replaces this when persistence matters.
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  create(req: CreateWorkspaceRequest): RegistryError | null {
    if (this.workspaces.has(req.workspace.id)) {
      return { code: 409, message: "workspace already exists" };
    }
    const record: WorkspaceRecord = {
      id: req.workspace.id,
      name: req.workspace.name,
      createdAt: req.workspace.createdAt,
      ...(req.workspace.expiresAt !== undefined
        ? { expiresAt: req.workspace.expiresAt }
        : {}),
      ownerDeviceId: req.device.id,
      devices: new Map([[req.device.id, { ...req.device, lastSeenAt: Date.now() }]]),
      pairing: { token: req.pairingToken, expiresAt: req.tokenExpiresAt, used: false },
    };
    this.workspaces.set(record.id, record);
    return null;
  }

  join(
    workspaceId: string,
    req: JoinWorkspaceRequest,
    isOnline: (deviceId: string) => boolean,
  ): JoinWorkspaceResponse | RegistryError {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return { code: 404, message: "unknown workspace" };
    if (ws.expiresAt !== undefined && Date.now() > ws.expiresAt) {
      return { code: 410, message: "workspace expired" };
    }
    const pairing = ws.pairing;
    if (
      !pairing ||
      pairing.used ||
      Date.now() > pairing.expiresAt ||
      pairing.token !== req.pairingToken
    ) {
      return { code: 403, message: "invalid or expired pairing token" };
    }
    pairing.used = true;
    ws.devices.set(req.device.id, { ...req.device, lastSeenAt: Date.now() });
    return {
      workspace: {
        id: ws.id,
        name: ws.name,
        ownerDeviceId: ws.ownerDeviceId,
        ...(ws.expiresAt !== undefined ? { expiresAt: ws.expiresAt } : {}),
      },
      devices: this.presence(workspaceId, isOnline),
    };
  }

  rotatePairing(
    workspaceId: string,
    deviceId: string,
    token: string,
    tokenExpiresAt: number,
  ): RegistryError | null {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return { code: 404, message: "unknown workspace" };
    if (ws.ownerDeviceId !== deviceId) {
      return { code: 403, message: "only the workspace owner can mint pairing tokens" };
    }
    ws.pairing = { token, expiresAt: tokenExpiresAt, used: false };
    return null;
  }

  /**
   * Remove a device from the workspace (owner only). It can no longer
   * authenticate to the relay. NOTE: the device may still hold the current
   * workspace key — full cryptographic revocation needs key rotation
   * (docs/Roadmap.md, phase 1 remainder).
   */
  removeDevice(
    workspaceId: string,
    requesterId: string,
    deviceId: string,
  ): RegistryError | null {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return { code: 404, message: "unknown workspace" };
    if (ws.ownerDeviceId !== requesterId) {
      return { code: 403, message: "only the workspace owner can revoke devices" };
    }
    if (deviceId === ws.ownerDeviceId) {
      return { code: 400, message: "the owner device cannot revoke itself" };
    }
    if (!ws.devices.delete(deviceId)) {
      return { code: 404, message: "device is not in this workspace" };
    }
    return null;
  }

  workspaceExpired(workspaceId: string): boolean {
    const ws = this.workspaces.get(workspaceId);
    return !!ws?.expiresAt && Date.now() > ws.expiresAt;
  }

  getDevice(workspaceId: string, deviceId: string): StoredDevice | undefined {
    return this.workspaces.get(workspaceId)?.devices.get(deviceId);
  }

  deviceIds(workspaceId: string): string[] {
    const ws = this.workspaces.get(workspaceId);
    return ws ? [...ws.devices.keys()] : [];
  }

  presence(
    workspaceId: string,
    isOnline: (deviceId: string) => boolean,
  ): PresenceEntry[] {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) return [];
    return [...ws.devices.values()].map((device) => ({
      id: device.id,
      name: device.name,
      publicKey: device.publicKey,
      ...(device.encryptionKey !== undefined
        ? { encryptionKey: device.encryptionKey }
        : {}),
      ...(device.capabilities !== undefined ? { capabilities: device.capabilities } : {}),
      type: device.type,
      online: isOnline(device.id),
      lastSeenAt: device.lastSeenAt,
    }));
  }

  touch(workspaceId: string, deviceId: string, at: number): void {
    const device = this.workspaces.get(workspaceId)?.devices.get(deviceId);
    if (device) device.lastSeenAt = at;
  }

  /** A device updates what it advertises (e.g. "I now expose a terminal"). */
  setCapabilities(
    workspaceId: string,
    deviceId: string,
    capabilities: string[],
  ): RegistryError | null {
    const device = this.workspaces.get(workspaceId)?.devices.get(deviceId);
    if (!device) return { code: 404, message: "device is not in this workspace" };
    device.capabilities = capabilities;
    return null;
  }
}
