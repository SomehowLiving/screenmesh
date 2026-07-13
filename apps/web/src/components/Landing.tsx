import { useState } from "react";

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
      {(props.error ?? error) && <div className="error">{props.error ?? error}</div>}
      <div className="grid" style={{ width: "min(760px, 95vw)" }}>
        <section className="card stack">
          <h2>Create a workspace</h2>
          <p className="muted">
            This device becomes the owner and can pair others via QR code or link.
          </p>
          <input
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
          />
          <select value={ttlIndex} onChange={(e) => setTtlIndex(Number(e.target.value))}>
            {TTL_CHOICES.map((choice, i) => (
              <option key={choice.label} value={i}>
                {choice.label}
              </option>
            ))}
          </select>
          <button
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
            Create workspace
          </button>
        </section>
        <section className="card stack">
          <h2>Join a workspace</h2>
          <p className="muted">
            Scan the owner's QR with your camera, or paste the join link / code here.
          </p>
          <textarea
            placeholder="Paste join link or pairing code"
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
            Join
          </button>
        </section>
      </div>
    </div>
  );
}
