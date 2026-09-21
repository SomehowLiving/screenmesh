import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { PairingPayload } from "@screenmesh/protocol";
import {
  listLanCandidates,
  makeJoinUrl,
  rotatePairing,
  type LanCandidate,
  type LocalIdentity,
  type LocalWorkspace,
} from "../lib/app.js";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { LockIcon } from "./mesh-icons.js";
import {
  companionRouteLabel,
  getCompanionLanSession,
  requestCompanionRoutes,
  startCompanionLanSession,
  stopCompanionLanSession,
  type CompanionLanSession,
  type CompanionRoute,
} from "../lib/companion.js";

/**
 * Presentation-only masking of the join link: the real, fully-functional
 * URL is still what "Copy access link" puts on the clipboard and what
 * the QR encodes — this only changes what's rendered inline, so a raw
 * "http://192.168.1.5:5173/#join=..." dev-server URL never has to be
 * shown to someone pairing a device.
 */
function maskedAccessLink(url: string): string {
  try {
    const parsed = new URL(url);
    const tokenLength = (parsed.hash || parsed.pathname).replace(/[^A-Za-z0-9]/g, "").length;
    const dots = "•".repeat(Math.min(24, Math.max(12, tokenLength / 3)));
    return `mesh://${dots}`;
  } catch {
    return "mesh://••••••••••••••••";
  }
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "00:00";
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function PairPanel(props: {
  me: LocalIdentity;
  workspace: LocalWorkspace;
  workspaceKey: CryptoKey;
  initialPairing: PairingPayload | null;
}) {
  const isOwner = props.me.deviceId === props.workspace.ownerDeviceId;
  const [pairing, setPairing] = useState<PairingPayload | null>(props.initialPairing);
  const [candidates, setCandidates] = useState<LanCandidate[]>([]);
  const [companionRoutes, setCompanionRoutes] = useState<CompanionRoute[]>([]);
  const [selectedCompanionRoute, setSelectedCompanionRoute] = useState("");
  const [companionChecked, setCompanionChecked] = useState(false);
  const [lanSession, setLanSession] = useState<CompanionLanSession | null>(null);
  const [lanSessionBusy, setLanSessionBusy] = useState(false);
  const [selectedOrigin, setSelectedOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Kept only in page memory. SM2 QR generation will use it in the next
  // phase; it is intentionally never rendered or persisted.
  const lanSessionTokenRef = useRef<string | null>(null);
  const joinUrl = pairing ? makeJoinUrl(pairing) : null;

  async function regenerate(originOverride?: string) {
    try {
      setError(null);
      if (lanSession) {
        await stopCompanionLanSession(lanSession.sessionId).catch(() => undefined);
        setLanSession(null);
        lanSessionTokenRef.current = null;
      }
      setPairing(await rotatePairing(props.me, props.workspace, props.workspaceKey, originOverride));
      setCopied(false);
    } catch (err) {
      setError(`Could not create pairing code: ${err instanceof Error ? err.message : err}`);
    }
  }

  useEffect(() => {
    if (!isOwner) return;
    void listLanCandidates()
      .then((found) => {
        setCandidates(found);
        if (found[0]) setSelectedOrigin(found[0].origin);
      })
      .catch(() => {});
    if (!pairing) void regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshCompanionRoutes(): Promise<void> {
    try {
      const routes = await requestCompanionRoutes();
      setCompanionRoutes(routes);
      setSelectedCompanionRoute((selected) => {
        if (routes.some((route) => route.address === selected)) return selected;
        return routes.find((route) => route.recommended)?.address ?? routes[0]?.address ?? "";
      });
    } catch {
      // The companion is optional. A missing extension/agent must not change
      // normal relay pairing or surface a distracting error.
      setCompanionRoutes([]);
    } finally {
      setCompanionChecked(true);
    }
  }

  useEffect(() => {
    void refreshCompanionRoutes();
    void getCompanionLanSession().then(setLanSession).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activateLocalListener(): Promise<void> {
    const route = companionRoutes.find((candidate) => candidate.address === selectedCompanionRoute);
    if (!route || !pairing) return;
    const risky = route.kind === "vpn" || route.kind === "virtual";
    if (risky && !window.confirm(`Start a LAN listener on ${companionRouteLabel(route)}? Devices reachable through this ${route.kind} interface could attempt the pairing handshake.`)) {
      return;
    }
    try {
      setError(null);
      setLanSessionBusy(true);
      const { session, sessionToken } = await startCompanionLanSession({
        address: route.address,
        expiresAt: pairing.expiresAt,
        ...(risky ? { allowUnsafeRoute: true } : {}),
      });
      setLanSession(session);
      lanSessionTokenRef.current = sessionToken;
      setPairing((current) => current ? {
        ...current,
        lanEndpoint: {
          address: session.address,
          port: session.port,
          certificateSha256: session.certificateSha256,
          sessionId: session.sessionId,
          sessionToken,
        },
      } : current);
    } catch (err) {
      setError(`Could not start local listener: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLanSessionBusy(false);
    }
  }

  async function stopLocalListener(): Promise<void> {
    if (!lanSession) return;
    try {
      setLanSessionBusy(true);
      await stopCompanionLanSession(lanSession.sessionId);
      setLanSession(null);
      lanSessionTokenRef.current = null;
      setPairing((current) => {
        if (!current?.lanEndpoint) return current;
        const { lanEndpoint: _lanEndpoint, ...relayOnlyPairing } = current;
        return relayOnlyPairing;
      });
    } catch (err) {
      setError(`Could not stop local listener: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLanSessionBusy(false);
    }
  }

  useEffect(() => {
    if (canvasRef.current && joinUrl) {
      void QRCode.toCanvas(canvasRef.current, joinUrl, { width: 240, margin: 2, errorCorrectionLevel: "L" });
    }
  }, [joinUrl]);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  // Live self-destruct countdown — ticks off the real pairing.expiresAt.
  useEffect(() => {
    if (!pairing) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pairing]);

  if (!isOwner) {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
        <p className="font-medium text-warning">Only the workspace owner can pair devices.</p>
        <p className="mt-1 text-xs text-muted-foreground">Ask the owner device to display its QR code.</p>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid items-start gap-6 md:grid-cols-[272px_minmax(0,1fr)] md:gap-8">
        <div className="grid aspect-square w-full place-items-center rounded-lg border border-border bg-white p-4">
          {joinUrl && <canvas ref={canvasRef} className="h-auto max-w-full" />}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <p className="text-sm font-semibold">Connect a new screen</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Scan this QR code with the device you want to pair. The code is single-use and self-destructs after its TTL.
            </p>
          </div>

          {joinUrl && (
            <div className="flex items-center rounded-md border border-input bg-background">
              <span
                className="min-w-0 flex-1 truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                title="The real link is copied — this display is masked for presentation."
              >
                {maskedAccessLink(joinUrl)}
              </span>
              <button
                type="button"
                className="border-l border-border px-3 py-2 text-xs font-medium hover:bg-accent"
                onClick={async () => {
                  await navigator.clipboard.writeText(joinUrl);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy access link"}
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-success" /> Single use</span>
            <span className="flex items-center gap-1"><LockIcon className="size-3" /> Encrypted</span>
            {pairing && <span>Self-destructs {formatCountdown(pairing.expiresAt - now)}</span>}
          </div>

          {candidates.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/35 p-3">
              <div className="mb-2.5">
                <p className="text-xs font-medium">Network interface</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Choose a different local route if the QR code is not reachable.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <SelectMenu
                  className="min-w-0 flex-1"
                  ariaLabel="Network interface"
                  value={selectedOrigin}
                  onValueChange={setSelectedOrigin}
                  options={candidates.map((candidate) => ({
                    value: candidate.origin,
                    label: candidate.name,
                    description: candidate.address,
                  }))}
                />
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => void regenerate(selectedOrigin)}>
                  Use this network
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border bg-muted/35 p-3">
            <div className="mb-2.5 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium">Local companion routes</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {companionRoutes.length > 0
                    ? "Choose an interface, then explicitly activate a temporary local listener."
                    : companionChecked
                      ? "No local companion is connected. Relay pairing will be used."
                      : "Checking for the optional local companion…"}
                </p>
              </div>
              <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void refreshCompanionRoutes()}>
                Refresh
              </Button>
            </div>
            {companionRoutes.length > 0 && (
              <>
                <SelectMenu
                  ariaLabel="Local companion route"
                  value={selectedCompanionRoute}
                  onValueChange={setSelectedCompanionRoute}
                  options={companionRoutes.map((route) => ({
                    value: route.address,
                    label: `${companionRouteLabel(route)}${route.recommended ? " — Recommended" : ""}`,
                    description: route.address,
                  }))}
                />
                {companionRoutes.find((route) => route.address === selectedCompanionRoute)?.kind === "vpn" && (
                  <p className="mt-2 text-[11px] text-warning">VPN selected. Only use it when the receiving device can reach that VPN.</p>
                )}
                {companionRoutes.find((route) => route.address === selectedCompanionRoute)?.kind === "virtual" && (
                  <p className="mt-2 text-[11px] text-warning">Virtual adapter selected. It is usually not reachable from a phone.</p>
                )}
                {lanSession ? (
                  <div className="mt-2 rounded border border-success/30 bg-success/10 p-2 text-[11px] text-success">
                    <p>Local listener active on {lanSession.address}:{lanSession.port}; expires with this pairing code.</p>
                    <p className="mt-1 text-muted-foreground">This QR now carries the pinned local bootstrap for Android. Browser joins safely use the relay.</p>
                    <Button size="sm" variant="outline" className="mt-2 h-7 px-2 text-[11px]" disabled={lanSessionBusy} onClick={() => void stopLocalListener()}>
                      Stop local listener
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-[11px] text-muted-foreground">The listener is TLS-protected, bound only to this address, and requires a one-use session token.</p>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={lanSessionBusy || !selectedCompanionRoute || !pairing} onClick={() => void activateLocalListener()}>
                      {lanSessionBusy ? "Starting…" : "Activate local listener"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="border-t border-border pt-3">
            <Button size="sm" variant="outline" onClick={() => void regenerate()}>
              Generate a new code
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
