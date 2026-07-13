/**
 * Store–carry–forward: when the destination is unreachable, the encrypted
 * bundle waits in the outbox. Any trusted device may carry it toward the
 * destination without being able to read it. See docs/Architecture.md §2.
 */
export interface DeliveryBundle {
  bundleId: string;
  sourceDeviceId: string;
  destinationDeviceId: string;
  workspaceId: string;
  encryptedPayload: Uint8Array;
  createdAt: number;
  expiresAt: number;
  /** Remaining device-to-device hops before the bundle is dropped. */
  hopLimit: number;
  signature: Uint8Array;
}

export const DEFAULT_HOP_LIMIT = 4;
