import { useEffect, useMemo, useState } from "react";
import type { PairingPayload } from "@screenmesh/protocol";
import type { TransportStatus, WebSocketRelayTransport } from "@screenmesh/transport";
import { ScreenMeshDb } from "@screenmesh/storage";
import {
  buildEngine,
  createLocalIdentity,
  createWorkspaceOnServer,
  joinWorkspaceFromPayload,
  leaveWorkspace,
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
import {
  DeviceIcon,
  InboxIcon,
  KeyIcon,
  MeshIcon,
  PairIcon,
  RouteIcon,
  SendIcon,
  SettingsIcon,
} from "./components/ui/Icons.js";

const STATUS_LABEL: Record<TransportStatus, string> = {
  idle: "IDLE",
  discovering: "SCANNING",
  connecting: "SYNCING",
  connected: "LINK SECURE",
  disconnected: "LINK DOWN",
  error: "LINK ERROR",
};

function ConnBadge(props: { transport: WebSocketRelayTransport }) {
  const [status, setStatus] = useState<TransportStatus>(
    props.transport.isConnected ? "connected" : "connecting",
  );
  useEffect(() => props.transport.subscribeStatus(setStatus), [props.transport]);
  return (
    <span className={`conn-status ${status}`}>
      <span className="status-led" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function App() {
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
  const [pairOpen, setPairOpen] = useState(false);

  async function resetToLanding(message: string) {
    await leaveWorkspace(db);
    setWsState(null);
    setInitialPairing(null);
    setPairOpen(false);
    setError(message);
  }

  useEffect(() => {
    void (async () => {
      const local = await loadLocal(db);
      setMe(local.identity);

      if (local.workspace && local.key) {
        if (
          local.workspace.expiresAt !== undefined &&
          Date.now() > local.workspace.expiresAt
        ) {
          await leaveWorkspace(db);
          setError(`Workspace "${local.workspace.name}" has expired and was cleaned up.`);
        } else {
          setWsState({ workspace: local.workspace, key: local.key });
        }
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

  useEffect(() => {
    if (!me || !wsState) return;

    const built = buildEngine(db, me, wsState.workspace, wsState.key);
    setSession(built);

    const unsubscribe = built.transport.subscribeAuthError((reason) => {
      void resetToLanding(
        reason === "workspace expired"
          ? "This workspace has expired. Its local data was cleaned up."
          : `This device no longer has access (${reason}). Local workspace data was cleaned up.`,
      );
    });

    void built.engine.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("relay auth failed")) {
        setError(`Connection failed: ${message}`);
      }
    });

    return () => {
      unsubscribe();
      void built.engine.stop();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, me, wsState]);

  if (!loaded) return <div className="boot-screen">BOOTING SECURE MESH<span className="cursor">_</span></div>;

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

  if (pendingJoin) return <div className="boot-screen">ESTABLISHING LINK<span className="cursor">_</span></div>;

  if (!wsState) {
    return (
      <LandingView
        error={error}
        onCreate={async (name, ttlMs) => {
          const result = await createWorkspaceOnServer(db, me, name, ttlMs);
          setInitialPairing(result.pairing);
          setWsState({ workspace: result.workspace, key: result.key });
          setError(null);
        }}
        onJoinCode={(code) => setPendingJoin(parseJoinInput(code))}
      />
    );
  }

  if (!session) return <div className="boot-screen">OPENING CHANNEL<span className="cursor">_</span></div>;

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">SCREENMESH</div>
            <div className="brand-sub">PRIVATE DEVICE NETWORK</div>
          </div>
        </div>

        <nav className="nav">
          <button className="nav-item active" onClick={() => scrollTo("mesh")}>
            <MeshIcon /> Mesh
          </button>
          <button className="nav-item" onClick={() => scrollTo("mesh")}>
            <DeviceIcon /> Devices
          </button>
          <button className="nav-item" onClick={() => scrollTo("activity")}>
            <InboxIcon /> Inbox
          </button>
          <button className="nav-item" onClick={() => scrollTo("send")}>
            <SendIcon /> Send
          </button>
          <button className="nav-item" onClick={() => setPairOpen(true)}>
            <PairIcon /> Pair Device
          </button>
          <button className="nav-item" onClick={() => scrollTo("log")}>
            <RouteIcon /> Routes
          </button>
          <button className="nav-item" onClick={() => scrollTo("mesh")}>
            <KeyIcon /> Keys
          </button>
          <button className="nav-item" onClick={() => scrollTo("log")}>
            <SettingsIcon /> Settings
          </button>
        </nav>

        <div className="sidebar-status">
          <div className="eyebrow">SYSTEM STATUS</div>
          <div className="status-row"><span className="status-led" /> Mesh Active</div>
          <div className="status-row"><span className="status-led lock" /> E2EE Enabled</div>
          <div className="status-row"><span className="status-led" /> Local First</div>
        </div>

        <div className="sidebar-footer">
          MOVE FREELY.<br />
          STAY PRIVATE.<br /><br />
          SCREENMESH v0.1.0
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="channel">
            <span className="channel-label">CHANNEL ::</span>
            <strong>{wsState.workspace.name}</strong>
            <ConnBadge transport={session.transport} />
          </div>

          <div className="operator">
            <span>OPERATOR :: {me.name}</span>
            <span className="device-type">{me.deviceType}</span>
            <button
              className="terminate"
              onClick={() => {
                if (
                  window.confirm(
                    "Terminate this channel? Local workspace data will be wiped from this device.",
                  )
                ) {
                  void resetToLanding("Channel terminated.");
                }
              }}
            >
              TERMINATE
            </button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <div className="dashboard">
          <section id="mesh" className="mesh-panel">
            <div className="panel-head">
              <div>
                <span className="panel-index">01</span>
                <h2>YOUR DEVICE MESH</h2>
              </div>
              <button className="mini-action" onClick={() => setPairOpen(true)}>
                + PAIR DEVICE
              </button>
            </div>
            <DevicesPanel
              db={db}
              me={me}
              workspace={wsState.workspace}
              engine={session.engine}
              onIdentityChange={setMe}
            />
          </section>

          <section id="send" className="send-panel">
            <div className="panel-head">
              <div>
                <span className="panel-index">02</span>
                <h2>DISPATCH PAYLOAD</h2>
              </div>
            </div>
            <SendPanel db={db} me={me} engine={session.engine} />
          </section>

          <section id="activity" className="activity-panel">
            <div className="panel-head">
              <div>
                <span className="panel-index">03</span>
                <h2>RECENT ACTIVITY</h2>
              </div>
            </div>
            <InboxPanel db={db} me={me} engine={session.engine} />
          </section>

          <section id="sent" className="transfer-panel">
            <div className="panel-head">
              <div>
                <span className="panel-index">04</span>
                <h2>TRANSMISSIONS</h2>
              </div>
            </div>
            <SentPanel db={db} me={me} />
          </section>

          <section id="log" className="log-panel">
            <div className="panel-head">
              <div>
                <span className="panel-index">05</span>
                <h2>SYSTEM LOG</h2>
              </div>
              <span className="live-indicator"><span className="status-led" /> LIVE</span>
            </div>
            <div className="log-lines">
              <div><time>NOW</time><span className="log-tag">[SYSTEM]</span> Mesh session active.</div>
              <div><time>NOW</time><span className="log-tag">[SECURITY]</span> End-to-end encryption enabled.</div>
              <div><time>NOW</time><span className="log-tag">[ROUTE]</span> Transport negotiation active.</div>
              <div><time>NOW</time><span className="log-tag">[SYNC]</span> Local operation log ready.</div>
            </div>
          </section>
        </div>
      </main>

      {pairOpen && (
        <div className="modal-backdrop" onMouseDown={() => setPairOpen(false)}>
          <div className="pair-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <span className="panel-index">PAIR</span>
                <h2>CONNECT NEW DEVICE</h2>
              </div>
              <button className="modal-close" onClick={() => setPairOpen(false)}>×</button>
            </div>
            <PairPanel
              me={me}
              workspace={wsState.workspace}
              workspaceKey={wsState.key}
              initialPairing={initialPairing}
            />
          </div>
        </div>
      )}
    </div>
  );
}
