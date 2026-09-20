import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
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
import { Button } from "./components/ui/button.js";
import {
  ActivityIcon,
  CloseIcon,
  DevicesIcon,
  InboxIcon,
  LockIcon,
  MeshMark,
  MoonIcon,
  PlusIcon,
  SunIcon,
} from "./components/mesh-icons.js";

const STATUS_LABEL: Record<TransportStatus, string> = {
  idle: "Idle",
  discovering: "Scanning",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Offline",
  error: "Connection error",
};

const FEED_FILTERS = ["All objects", "Sent", "Text", "Link", "Code", "Command", "Checklist"];

function ConnBadge(props: { transport: WebSocketRelayTransport }) {
  const [status, setStatus] = useState<TransportStatus>(
    props.transport.isConnected ? "connected" : "connecting",
  );
  useEffect(() => props.transport.subscribeStatus(setStatus), [props.transport]);
  const isUp = status === "connected";
  return (
    <span className="hidden items-center gap-2 text-[11px] text-muted-foreground md:flex">
      <span className={`size-1.5 rounded-full ${isUp ? "bg-success mesh-pulse" : "bg-muted-foreground/45"}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function useTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const saved = window.localStorage.getItem("screenmesh-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldUseDark = saved ? saved === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", shouldUseDark);
    setDark(shouldUseDark);
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem("screenmesh-theme", next ? "dark" : "light");
  };
  return { dark, toggle };
}

export function App() {
  const db = useMemo(() => {
    const suffix = new URLSearchParams(location.search).get("device") ?? "";
    return new ScreenMeshDb(`screenmesh${suffix}`);
  }, []);

  const [loaded, setLoaded] = useState(false);
  const [me, setMe] = useState<LocalIdentity | null>(null);
  const [wsState, setWsState] = useState<{ workspace: LocalWorkspace; key: CryptoKey } | null>(null);
  const [pendingJoin, setPendingJoin] = useState<PairingPayload | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [initialPairing, setInitialPairing] = useState<PairingPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [feedFilter, setFeedFilter] = useState("All objects");
  const { dark, toggle: toggleTheme } = useTheme();

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
        if (local.workspace.expiresAt !== undefined && Date.now() > local.workspace.expiresAt) {
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
      if (!message.includes("relay auth failed")) setError(`Connection failed: ${message}`);
    });

    return () => {
      unsubscribe();
      void built.engine.stop();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, me, wsState]);

  if (!loaded) return <BootScreen text="Loading" />;

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

  if (pendingJoin) return <BootScreen text="Joining workspace" />;

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

  if (!session) return <BootScreen text="Connecting" />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-14 items-center border-b border-border bg-background/95 px-4 backdrop-blur md:px-6">
        <div className="flex items-center gap-2.5">
          <MeshMark className="size-6" />
          <span className="text-sm font-semibold">ScreenMesh</span>
        </div>
        <div className="mx-4 hidden h-4 w-px bg-border sm:block" />
        <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span className="text-foreground">{me.name}</span><span>/</span><span>{wsState.workspace.name}</span>
        </span>
        <div className="ml-auto flex items-center gap-3">
          <ConnBadge transport={session.transport} />
          <Button variant="outline" size="sm" onClick={() => setPairOpen(true)}>
            <PlusIcon /> Pair device
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
            title={`Switch to ${dark ? "light" : "dark"} theme`}
            onClick={toggleTheme}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (window.confirm("Leave this workspace? Local workspace data will be removed from this device.")) {
                void resetToLanding("You left the workspace.");
              }
            }}
          >
            Leave
          </Button>
        </div>
      </header>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive md:px-6">
          {error}
        </div>
      )}

      <div className="grid min-h-[calc(100vh-3.5rem)] md:grid-cols-[208px_minmax(0,1fr)] xl:grid-cols-[208px_minmax(0,1fr)_320px]">
        <Sidebar db={db} me={me} />

        <main className="min-w-0 px-4 py-5 md:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <h1 className="text-lg font-semibold">Workspace</h1>
            <p className="text-xs text-muted-foreground">Temporary objects shared across your mesh.</p>

            <div className="mt-4">
              <SendPanel db={db} me={me} engine={session.engine} />
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
                <span className="text-xs font-medium text-foreground">Objects</span>
                <select
                  aria-label="Filter objects"
                  value={feedFilter}
                  onChange={(e) => setFeedFilter(e.target.value)}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                >
                  {FEED_FILTERS.map((filter) => (
                    <option key={filter} value={filter}>
                      {filter}
                    </option>
                  ))}
                </select>
              </div>
              <div className="px-3">
                {feedFilter === "Sent" ? (
                  <SentPanel db={db} me={me} />
                ) : (
                  <InboxPanel db={db} me={me} engine={session.engine} filter={feedFilter} />
                )}
              </div>
            </div>

            <section id="devices" className="mt-8 border-t border-border pt-6">
              <h2 className="text-sm font-semibold">Devices</h2>
              <p className="text-xs text-muted-foreground">Every device paired into this workspace.</p>
              <div className="mt-3">
                <DevicesPanel
                  db={db}
                  me={me}
                  workspace={wsState.workspace}
                  engine={session.engine}
                  onIdentityChange={setMe}
                />
              </div>
            </section>
          </div>
        </main>

        <RightRail db={db} me={me} />
      </div>

      {pairOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onMouseDown={() => setPairOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Pair a device</h2>
              <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setPairOpen(false)}>
                <CloseIcon />
              </Button>
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

function BootScreen({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      {text}…
    </div>
  );
}

function Sidebar(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const others = devices.filter((d) => d.id !== props.me.deviceId);
  const online = devices.filter((d) => d.status === "online").length;

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <aside className="hidden border-r border-border p-3 md:flex md:flex-col">
      <nav className="space-y-1">
        <NavItem active icon={<InboxIcon />} label="Workspace" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} />
        <NavItem icon={<DevicesIcon />} label="Devices" count={String(devices.length)} onClick={() => scrollTo("devices")} />
        <NavItem icon={<ActivityIcon />} label="Activity" />
      </nav>
      <div className="mt-5 px-2 text-[10px] font-medium uppercase text-muted-foreground">
        Devices ({online} online)
      </div>
      <div className="mt-1.5 space-y-0.5">
        {others.length === 0 ? (
          <p className="px-2 text-[11px] text-muted-foreground">No other devices paired yet.</p>
        ) : (
          others.map((device) => (
            <div key={device.id} className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left">
              <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-card font-mono text-[9px]">
                {device.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{device.name}</span>
                <span className="block truncate text-[10px] capitalize text-muted-foreground">{device.type}</span>
              </span>
              <span className={`size-1.5 shrink-0 rounded-full ${device.status === "online" ? "bg-success" : "bg-muted-foreground/45"}`} />
            </div>
          ))
        )}
      </div>
      <div className="mt-auto border-t border-border px-2 pt-3">
        <p className="text-[10px] leading-4 text-muted-foreground">
          Local-first and end-to-end encrypted. No account connected.
        </p>
      </div>
    </aside>
  );
}

function NavItem({ icon, label, count, active = false, onClick }: { icon: React.ReactNode; label: string; count?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs ${active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
    >
      <span className="[&_svg]:size-4">{icon}</span>
      <span>{label}</span>
      {count && <span className="ml-auto font-mono text-[9px]">{count}</span>}
    </button>
  );
}

function RightRail(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  const carried = useLiveQuery(() => props.db.carried.toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? "an offline device";

  return (
    <aside className="hidden border-l border-border p-4 xl:block">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold">Delivery queue</h2>
        {carried.length > 0 && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[9px] text-warning">
            {carried.length} PENDING
          </span>
        )}
      </div>
      {carried.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">Nothing queued right now.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {carried.map((bundle) => (
            <div key={bundle.bundleId} className="rounded-md border border-border bg-card p-2.5">
              <div className="flex items-center gap-2 text-[10px]">
                <LockIcon className="size-3.5" />
                <span>Encrypted bundle for {nameOf(bundle.destinationDeviceId)}</span>
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                Will deliver automatically when a trusted route becomes available.
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 border-t border-border pt-3">
        <h2 className="text-xs font-semibold">Transport priority</h2>
        <p className="mt-1.5 text-[10px] leading-5 text-muted-foreground">
          Direct WebRTC is tried first, falling back to the encrypted relay when peers can't
          connect directly, with local operations queued until a route opens.
        </p>
      </div>

      <div className="mt-5 border-t border-border pt-3">
        <div className="flex items-center gap-2 text-[11px] font-medium">
          <LockIcon className="size-4" /> End-to-end encrypted
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
          Keys never leave your devices. Relays can route objects, but cannot read them.
        </p>
      </div>
    </aside>
  );
}
