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
  const [selectedOrigin, setSelectedOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const joinUrl = pairing ? makeJoinUrl(pairing) : null;

  async function regenerate(originOverride?: string) {
    try {
      setError(null);
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
