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
import { Select } from "./ui/Select.js";

/**
 * Presentation-only masking of the join link: the real, fully-functional
 * URL is still what COPY ACCESS LINK puts on the clipboard and what the
 * QR encodes — this only changes what's rendered inline, so a raw
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
      setPairing(
        await rotatePairing(
          props.me,
          props.workspace,
          props.workspaceKey,
          originOverride,
        ),
      );
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
      void QRCode.toCanvas(canvasRef.current, joinUrl, {
        width: 260,
        margin: 2,
        errorCorrectionLevel: "L",
      });
    }
  }, [joinUrl]);

  // Live self-destruct countdown — ticks off the real pairing.expiresAt,
  // not a hardcoded "05:00" that would drift from the truth once a
  // minute has actually passed.
  useEffect(() => {
    if (!pairing) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pairing]);

  if (!isOwner) {
    return (
      <div className="pair-content">
        <div className="pair-warning">PAIRING CONTROLLED BY CHANNEL OWNER</div>
        <p className="muted">
          Only the channel owner can mint access codes. Ask the owner node to display its QR.
        </p>
      </div>
    );
  }

  return (
    <div className="pair-content">
      {error && <div className="error-banner">{error}</div>}

      <div className="pair-tabs">
        <span className="pair-tab active">QR CODE</span>
        <span className="pair-tab">MANUAL LINK</span>
      </div>

      <div className="pair-main">
        <div className="qr-frame">
          {joinUrl && <canvas ref={canvasRef} />}
        </div>

        <div className="pair-details">
          <div className="pair-title">SCAN TO INFILTRATE</div>
          <p className="muted">
            Scan this QR code with the device you want to pair. The code is single-use and
            self-destructs after its TTL.
          </p>

          {joinUrl && (
            <div className="join-link">
              <span title="The real link is copied — this display is masked for presentation.">
                {maskedAccessLink(joinUrl)}
              </span>
              <button
                className="copy-btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(joinUrl);
                  setCopied(true);
                }}
              >
                {copied ? "COPIED" : "COPY ACCESS LINK"}
              </button>
            </div>
          )}

          <div className="pair-meta">
            <span>● SINGLE USE</span>
            <span>⌑ ENCRYPTED</span>
            {pairing && <span>SELF-DESTRUCTS {formatCountdown(pairing.expiresAt - now)}</span>}
          </div>

          {candidates.length > 1 && (
            <div className="network-select">
              <label>ROUTE NETWORK</label>
              <Select
                ariaLabel="Network interface"
                value={selectedOrigin}
                onChange={setSelectedOrigin}
                options={candidates.map((c) => ({ value: c.origin, label: `${c.name} — ${c.address}` }))}
              />
              <button className="ghost" onClick={() => void regenerate(selectedOrigin)}>
                USE THIS NETWORK
              </button>
            </div>
          )}

          <button className="rotate-btn ghost" onClick={() => void regenerate()}>
            ↻ ROTATE KEY
          </button>
        </div>
      </div>
    </div>
  );
}
