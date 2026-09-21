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
  | { ok: false; error: string };

export function requestCompanionRoutes(timeoutMs = 1_500): Promise<CompanionRoute[]> {
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
      if (response?.ok) resolve(response.interfaces);
      else reject(new Error(response?.error ?? "ScreenMesh Local Companion did not respond."));
    }

    window.addEventListener("screenmesh-companion-response", onResponse);
    window.dispatchEvent(new CustomEvent("screenmesh-companion-request", { detail: { requestId } }));
  });
}
