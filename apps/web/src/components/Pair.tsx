import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { PairingPayload } from "@screenmesh/protocol";
import {
  makeJoinUrl,
  rotatePairing,
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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const joinUrl = pairing ? makeJoinUrl(pairing) : null;

  async function regenerate() {
    try {
      setError(null);
      setPairing(await rotatePairing(props.me, props.workspace, props.workspaceKey));
      setCopied(false);
    } catch (err) {
      setError(`Could not create pairing code: ${err instanceof Error ? err.message : err}`);
    }
  }

  useEffect(() => {
    if (isOwner && !pairing) void regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (canvasRef.current && joinUrl) {
      // Low error correction + the compact pairing code keep the module
      // count small; 300px with a quiet zone scans easily from a screen.
      void QRCode.toCanvas(canvasRef.current, joinUrl, {
        width: 300,
        margin: 2,
        errorCorrectionLevel: "L",
      });
    }
  }, [joinUrl]);

  if (!isOwner) {
    return (
      <section className="card">
        <h2>Pair a device</h2>
        <p className="muted">
          Only the workspace owner ({props.workspace.ownerDeviceId === props.me.deviceId ? "you" : "another device"})
          can mint pairing codes. Ask the owner device to show its QR.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Pair a device</h2>
      {error && <div className="error">{error}</div>}
      <div className="qr-wrap">
        {joinUrl && <canvas ref={canvasRef} />}
        <div className="stack" style={{ flex: 1, minWidth: 220 }}>
          <p className="muted">
            Scan with the other device's camera, or copy the link. Codes are{" "}
            <strong>single-use</strong> and expire in 5 minutes — generate a new one
            for each device.
          </p>
          {joinUrl && (
            <p className="muted">
              Link points at <span className="mono">{new URL(joinUrl).host}</span> —
            the other device must be on the same network. It will show a
            certificate warning once (self-signed dev cert); choose{" "}
            <em>Advanced&nbsp;→&nbsp;Proceed</em>.
            </p>
          )}
          {pairing && (
            <p className="muted">
              Expires {new Date(pairing.expiresAt).toLocaleTimeString()}
            </p>
          )}
          <div className="actions">
            <button
              className="ghost"
              disabled={!joinUrl}
              onClick={async () => {
                if (joinUrl) {
                  await navigator.clipboard.writeText(joinUrl);
                  setCopied(true);
                }
              }}
            >
              {copied ? "Copied!" : "Copy join link"}
            </button>
            <button onClick={() => void regenerate()}>New code</button>
          </div>
        </div>
      </div>
    </section>
  );
}
