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
          <div className="pair-title">CONNECT A NEW SCREEN</div>
          <p className="muted">
            Scan this QR code with the device you want to pair. The code is single-use and
            self-destructs after its TTL.
          </p>

          {joinUrl && (
            <div className="join-link">
              <span>{joinUrl}</span>
              <button
                className="copy-btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(joinUrl);
                  setCopied(true);
                }}
              >
                {copied ? "COPIED" : "COPY"}
              </button>
            </div>
          )}

          <div className="pair-meta">
            <span>● SINGLE USE</span>
            <span>⌑ E2EE</span>
            <span>TTL 05:00</span>
          </div>

          {candidates.length > 1 && (
            <div className="network-select">
              <label>NETWORK ORIGIN</label>
              <select
                value={selectedOrigin}
                onChange={(e) => setSelectedOrigin(e.target.value)}
              >
                {candidates.map((c) => (
                  <option key={c.origin} value={c.origin}>
                    {c.name} — {c.address}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={() => void regenerate(selectedOrigin)}>
                USE THIS NETWORK
              </button>
            </div>
          )}

          {pairing && (
            <div className="expiry-line">
              EXPIRES AT {new Date(pairing.expiresAt).toLocaleTimeString()}
            </div>
          )}

          <button className="rotate-btn" onClick={() => void regenerate()}>
            ↻ ROTATE KEY
          </button>
        </div>
      </div>
    </div>
  );
}
