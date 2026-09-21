/**
 * Browser-facing half of the optional Local Companion bridge.
 *
 * The extension injects a content script only into an origin the user chose in
 * its popup. A CustomEvent keeps this PWA independent of an extension ID and
 * means a missing extension simply behaves like the normal relay-only app.
 */
export interface CompanionRoute {
  name: string;
  address: string;
  kind: "wifi" | "ethernet" | "vpn" | "virtual" | "other";
  recommended: boolean;
}

export function companionRouteLabel(route: CompanionRoute): string {
  const kind = {
    wifi: "Wi-Fi",
    ethernet: "Ethernet",
    vpn: "VPN",
    virtual: "Virtual",
    other: "Network",
  }[route.kind];
  return `${route.name} (${kind})`;
}

type CompanionResponse =
  | { ok: true; interfaces: CompanionRoute[] }
  | { ok: true; session: CompanionLanSession | null }
  | { ok: true; stopped: boolean }
  | { ok: false; error: string };

export interface CompanionLanSession {
  sessionId: string;
  address: string;
  port: number;
  /** SPKI pin for the later Android-native client; never a browser TLS bypass. */
  certificateSha256: string;
  expiresAt: number;
  status: "listening" | "connected";
}

type CompanionRequest =
  | { type: "screenmesh.listNetworkInterfaces" }
  | { type: "screenmesh.startLanSession"; address: string; sessionId: string; sessionToken: string; expiresAt: number; allowUnsafeRoute?: boolean }
  | { type: "screenmesh.stopLanSession"; sessionId?: string }
  | { type: "screenmesh.getLanSession" };

function requestCompanion(request: CompanionRequest, timeoutMs = 3_000): Promise<CompanionResponse> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = window.setTimeout(() => {
      window.removeEventListener("screenmesh-companion-response", onResponse);
      reject(new Error("ScreenMesh Local Companion did not respond."));
    }, timeoutMs);

    function onResponse(event: Event): void {
      const detail = (event as CustomEvent<{ requestId?: unknown; response?: unknown }>).detail;
      if (detail?.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener("screenmesh-companion-response", onResponse);
      const response = detail.response as CompanionResponse | undefined;
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error ?? "ScreenMesh Local Companion did not respond."));
    }

    window.addEventListener("screenmesh-companion-response", onResponse);
    window.dispatchEvent(new CustomEvent("screenmesh-companion-request", { detail: { requestId, request } }));
  });
}

export async function requestCompanionRoutes(): Promise<CompanionRoute[]> {
  const response = await requestCompanion({ type: "screenmesh.listNetworkInterfaces" });
  if (!("interfaces" in response)) throw new Error("Companion returned an invalid route response.");
  return response.interfaces;
}

export async function startCompanionLanSession(params: {
  address: string;
  expiresAt: number;
  allowUnsafeRoute?: boolean;
}): Promise<{ session: CompanionLanSession; sessionToken: string }> {
  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const response = await requestCompanion({
    type: "screenmesh.startLanSession",
    address: params.address,
    sessionId,
    sessionToken,
    expiresAt: params.expiresAt,
    ...(params.allowUnsafeRoute ? { allowUnsafeRoute: true } : {}),
  });
  if (!("session" in response) || !response.session) throw new Error("Companion did not start a LAN listener.");
  return { session: response.session, sessionToken };
}

export async function stopCompanionLanSession(sessionId?: string): Promise<boolean> {
  const response = await requestCompanion({
    type: "screenmesh.stopLanSession",
    ...(sessionId ? { sessionId } : {}),
  });
  if (!("stopped" in response)) throw new Error("Companion returned an invalid stop response.");
  return response.stopped;
}

export async function getCompanionLanSession(): Promise<CompanionLanSession | null> {
  const response = await requestCompanion({ type: "screenmesh.getLanSession" });
  if (!("session" in response)) throw new Error("Companion returned an invalid session response.");
  return response.session;
}
