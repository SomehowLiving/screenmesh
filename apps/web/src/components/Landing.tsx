import { useState } from "react";
import { Select } from "./ui/Select.js";

const TTL_CHOICES: Array<{ label: string; ms?: number }> = [
  { label: "Never expires" },
  { label: "Expires in 1 hour", ms: 60 * 60 * 1000 },
  { label: "Expires in 6 hours", ms: 6 * 60 * 60 * 1000 },
  { label: "Expires in 24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "Expires in 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
];

export function LandingView(props: {
  error: string | null;
  onCreate: (name: string, ttlMs?: number) => Promise<void>;
  onJoinCode: (code: string) => void;
}) {
  const [workspaceName, setWorkspaceName] = useState("My Workspace");
  const [ttlIndex, setTtlIndex] = useState(0);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="center">
      <h1>ScreenMesh</h1>
      <p className="tagline">Private device network</p>
      <p className="landing-lede">Your devices. One encrypted mesh.</p>
      <p className="landing-guarantees">NO ACCOUNT &nbsp;·&nbsp; NO CLOUD &nbsp;·&nbsp; NO CENTRAL SERVER</p>
      {(props.error ?? error) && <div className="error">{props.error ?? error}</div>}
      <div className="grid" style={{ width: "min(760px, 95vw)" }}>
        <section className="card stack">
          <h2>Establish channel</h2>
          <p className="muted">
            This node becomes the owner and can admit others via QR handshake or link.
          </p>
          <input
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
          />
          <Select
            ariaLabel="Channel expiration"
            value={ttlIndex}
            onChange={setTtlIndex}
            options={TTL_CHOICES.map((choice, i) => ({ value: i, label: choice.label }))}
          />
          <button
            className="btn-primary"
            disabled={busy || !workspaceName.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onCreate(workspaceName.trim(), TTL_CHOICES[ttlIndex]?.ms);
              } catch (err) {
                setError(`Could not create workspace: ${err instanceof Error ? err.message : err}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            Initialize channel
          </button>
        </section>
        <section className="card stack">
          <h2>Infiltrate channel</h2>
          <p className="muted">
            Scan the owner's QR with your camera, or paste the access link / code below.
          </p>
          <textarea
            placeholder="Paste access link or pairing code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
          <button
            className="ghost"
            disabled={!joinCode.trim()}
            onClick={() => {
              try {
                setError(null);
                props.onJoinCode(joinCode);
              } catch {
                setError("That doesn't look like a valid pairing code.");
              }
            }}
          >
            Connect
          </button>
        </section>
      </div>
    </div>
  );
}
