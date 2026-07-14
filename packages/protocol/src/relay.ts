import type { DeviceInfo } from "./types.js";
import type { EnvelopeJson } from "./envelope.js";

/** Relay wire protocol (client ↔ server) and the pairing HTTP API. */

export interface PresenceEntry extends DeviceInfo {
  online: boolean;
  lastSeenAt: number;
}

export type RelayClientMessage =
  | {
      type: "auth";
      deviceId: string;
      workspaceId: string;
      /** Base64 Ed25519 signature over the challenge nonce (utf-8). */
      signature: string;
    }
  | { type: "envelope"; envelope: EnvelopeJson }
  | {
      /** WebRTC signaling (offers/answers/ICE), forwarded verbatim. */
      type: "signal";
      to: string;
      data: unknown;
    }
  | { type: "ping" };

export type RelayServerMessage =
  | { type: "challenge"; nonce: string }
  | { type: "authOk"; queued: number }
  | { type: "authError"; reason: string }
  | { type: "envelope"; envelope: EnvelopeJson }
  | { type: "presence"; devices: PresenceEntry[] }
  | { type: "signal"; from: string; data: unknown }
  | { type: "pong" }
  | { type: "error"; reason: string };

/** POST /workspaces */
export interface CreateWorkspaceRequest {
  workspace: { id: string; name: string; createdAt: number; expiresAt?: number };
  device: DeviceInfo;
  pairingToken: string;
  tokenExpiresAt: number;
}

/** POST /workspaces/:id/join */
export interface JoinWorkspaceRequest {
  pairingToken: string;
  device: DeviceInfo;
}

export interface JoinWorkspaceResponse {
  workspace: { id: string; name: string; ownerDeviceId: string; expiresAt?: number };
  devices: PresenceEntry[];
}

/** POST /workspaces/:id/pairing-token (owner only) */
export interface RotatePairingRequest {
  deviceId: string;
  pairingToken: string;
  tokenExpiresAt: number;
}

/** POST /workspaces/:id/revoke (owner only) */
export interface RevokeDeviceRequest {
  ownerDeviceId: string;
  deviceId: string;
}
