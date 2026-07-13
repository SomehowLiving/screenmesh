import { useState } from "react";

export function LandingView(props: {
  error: string | null;
  onCreate: (name: string) => Promise<void>;
  onJoinCode: (code: string) => void;
}) {
  const [workspaceName, setWorkspaceName] = useState("My Workspace");
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
          <button
            disabled={busy || !workspaceName.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onCreate(workspaceName.trim());
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
