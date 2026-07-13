import { useEffect, useMemo, useState } from "react";
import type { PairingPayload } from "@screenmesh/protocol";
import type { TransportStatus, WebSocketRelayTransport } from "@screenmesh/transport";
import { ScreenMeshDb } from "@screenmesh/storage";
import {
  buildEngine,
  createLocalIdentity,
  createWorkspaceOnServer,
  joinWorkspaceFromPayload,
  loadLocal,
  parseJoinInput,
  type LocalIdentity,
  type LocalWorkspace,
  type Session,
} from "./lib/app.js";
import { SetupView } from "./components/Setup.js";
import { LandingView } from "./components/Landing.js";
import { PairPanel } from "./components/Pair.js";
import { DevicesPanel } from "./components/Devices.js";
import { SendPanel } from "./components/Send.js";
import { InboxPanel } from "./components/Inbox.js";
import { SentPanel } from "./components/Sent.js";

function ConnBadge(props: { transport: WebSocketRelayTransport }) {
  const [status, setStatus] = useState<TransportStatus>(
    props.transport.isConnected ? "connected" : "connecting",
  );
  useEffect(() => props.transport.subscribeStatus(setStatus), [props.transport]);
  return <span className={`badge ${status}`}>{status}</span>;
}

export function App() {
  // `?device=2` uses a separate local DB — handy for testing several
  // "devices" in one browser. Real usage: one DB per device.
  const db = useMemo(() => {
    const suffix = new URLSearchParams(location.search).get("device") ?? "";
    return new ScreenMeshDb(`screenmesh${suffix}`);
  }, []);

  const [loaded, setLoaded] = useState(false);
  const [me, setMe] = useState<LocalIdentity | null>(null);
  const [wsState, setWsState] = useState<{
    workspace: LocalWorkspace;
    key: CryptoKey;
  } | null>(null);
  const [pendingJoin, setPendingJoin] = useState<PairingPayload | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [initialPairing, setInitialPairing] = useState<PairingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const local = await loadLocal(db);
      setMe(local.identity);
      if (local.workspace && local.key) {
        setWsState({ workspace: local.workspace, key: local.key });
      }
      const hash = location.hash;
      if (hash.startsWith("#join=")) {
        try {
          setPendingJoin(parseJoinInput(hash));
        } catch {
          setError("That join link is invalid or has expired.");
        }
        history.replaceState(null, "", location.pathname + location.search);
      }
      setLoaded(true);
    })();
  }, [db]);

  // Join automatically once we have an identity and a pending payload.
  useEffect(() => {
    if (!loaded || !me || !pendingJoin) return;
    void (async () => {
      try {
        const joined = await joinWorkspaceFromPayload(db, me, pendingJoin);
        setWsState(joined);
        setError(null);
      } catch (err) {
        setError(`Could not join workspace: ${err instanceof Error ? err.message : err}`);
      } finally {
        setPendingJoin(null);
      }
    })();
  }, [loaded, me, pendingJoin, db]);

  // Engine lifecycle.
  useEffect(() => {
    if (!me || !wsState) return;
    const built = buildEngine(db, me, wsState.workspace, wsState.key);
    setSession(built);
    void built.engine.start().catch((err) => {
      setError(`Connection failed: ${err instanceof Error ? err.message : err}`);
    });
    return () => {
      void built.engine.stop();
      setSession(null);
    };
  }, [db, me, wsState]);

  if (!loaded) return <div className="center">Loading…</div>;

  if (!me) {
    return (
      <SetupView
        joining={pendingJoin !== null}
        onDone={(name, type) => {
          void createLocalIdentity(db, name, type).then(setMe);
        }}
      />
    );
  }

  if (pendingJoin) return <div className="center">Joining workspace…</div>;

  if (!wsState) {
    return (
      <LandingView
        error={error}
        onCreate={async (name) => {
          const result = await createWorkspaceOnServer(db, me, name);
          setInitialPairing(result.pairing);
          setWsState({ workspace: result.workspace, key: result.key });
          setError(null);
        }}
        onJoinCode={(code) => setPendingJoin(parseJoinInput(code))}
      />
    );
  }

  if (!session) return <div className="center">Connecting…</div>;

  return (
    <div className="app">
      <header className="bar">
        <h1>ScreenMesh</h1>
        <span className="muted">{wsState.workspace.name}</span>
        <ConnBadge transport={session.transport} />
        <span className="spacer" />
        <span className="muted">
          {me.name} · {me.deviceType}
        </span>
      </header>
      {error && <div className="error">{error}</div>}
      <div className="grid">
        <PairPanel
          me={me}
          workspace={wsState.workspace}
          workspaceKey={wsState.key}
          initialPairing={initialPairing}
        />
        <DevicesPanel db={db} me={me} />
        <SendPanel db={db} me={me} engine={session.engine} />
        <InboxPanel db={db} me={me} engine={session.engine} />
        <SentPanel db={db} me={me} />
      </div>
    </div>
  );
}
