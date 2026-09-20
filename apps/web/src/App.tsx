import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { PairingPayload } from "@screenmesh/protocol";
import type { TransportStatus, WebSocketRelayTransport } from "@screenmesh/transport";
import { ScreenMeshDb } from "@screenmesh/storage";
import type { MeshEngine } from "@screenmesh/sync";
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
import { ActivityPanel } from "./components/Activity.js";
import { LibraryPanel } from "./components/Library.js";
import { Button } from "./components/ui/button.js";
import {
  ActivityIcon,
  ArrowUpIcon,
  CloseIcon,
  DeviceTypeIcon,
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

const FEED_FILTERS = ["Active", "Shared with me", "Sent by me", "Needs attention"];
type WorkspaceView = "workspace" | "library" | "transfers" | "devices" | "mesh" | "activity" | "security";

function currentWorkspaceView(): WorkspaceView {
  const view = new URLSearchParams(location.search).get("view");
  return view === "library" || view === "devices" || view === "transfers" || view === "mesh" || view === "activity" || view === "security" ? view : "workspace";
}

function workspaceViewHref(view: WorkspaceView, deviceId?: string) {
  const url = new URL(location.href);
  if (view === "workspace") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  if (deviceId) url.searchParams.set("deviceId", deviceId);
  else url.searchParams.delete("deviceId");
  return `${url.pathname}${url.search}`;
}

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
  const [activeView, setActiveView] = useState<WorkspaceView>(currentWorkspaceView);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("deviceId"),
  );
  const { dark, toggle: toggleTheme } = useTheme();

  function navigateWorkspace(view: WorkspaceView, deviceId?: string) {
    history.pushState(null, "", workspaceViewHref(view, deviceId));
    setActiveView(view);
    setSelectedDeviceId(deviceId ?? null);
  }

  useEffect(() => {
    const syncFromHistory = () => {
      setActiveView(currentWorkspaceView());
      setSelectedDeviceId(new URLSearchParams(location.search).get("deviceId"));
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  useEffect(() => {
    if (!pairOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPairOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pairOpen]);

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
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <header className="z-20 flex h-14 shrink-0 items-center border-b border-border bg-background/95 px-3 backdrop-blur-md sm:px-4 md:px-6">
        <div className="flex items-center gap-2.5">
          <MeshMark className="size-6" />
          <span className="text-sm font-semibold">ScreenMesh</span>
        </div>
        <div className="mx-4 hidden h-4 w-px bg-border sm:block" />
        <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span className="text-foreground">{me.name}</span><span>/</span><span>{wsState.workspace.name}</span>
        </span>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
          <ConnBadge transport={session.transport} />
          <Button variant="outline" size="sm" onClick={() => setPairOpen(true)}>
            <PlusIcon /> <span className="hidden sm:inline">Pair device</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex"
            aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
            title={`Switch to ${dark ? "light" : "dark"} theme`}
            onClick={toggleTheme}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
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
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive md:px-6">
          {error}
        </div>
      )}

      <MobileNavigation activeView={activeView} onNavigate={navigateWorkspace} />

      <div className="grid min-h-0 flex-1 md:grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[236px_minmax(0,1fr)_320px]">
        <Sidebar db={db} me={me} activeView={activeView} onNavigate={navigateWorkspace} />

        <main className="min-h-0 min-w-0 overflow-hidden px-3 py-4 sm:px-4 sm:py-5 md:px-7 lg:px-10">
          <div className="mx-auto flex h-full max-w-4xl flex-col">
            {activeView === "workspace" ? (
              <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold tracking-[-0.02em]">Workspace</h1>
                <p className="mt-1 text-xs text-muted-foreground">Temporary objects shared across your mesh.</p>
              </div>
              <span className="hidden font-mono text-[10px] uppercase tracking-wide text-muted-foreground lg:block">Local workspace</span>
            </div>

            <div className="mt-6">
              <SendPanel db={db} me={me} engine={session.engine} />
            </div>

            <div className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border">
                {FEED_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={feedFilter === filter}
                    onClick={() => setFeedFilter(filter)}
                    className={`shrink-0 border-b px-3 py-2.5 text-xs transition-colors ${feedFilter === filter ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    {filter}
                  </button>
                ))}
                <span className="ml-auto hidden shrink-0 pb-2.5 pl-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground sm:block">Objects</span>
              </div>
              <div className="min-h-0 overflow-y-auto">
                {feedFilter === "Sent by me" ? (
                  <SentPanel db={db} me={me} />
                ) : (
                  <InboxPanel db={db} me={me} engine={session.engine} filter={feedFilter} />
                )}
              </div>
            </div>
              </>
            ) : activeView === "library" ? (
              <LibraryPanel db={db} me={me} engine={session.engine} />
            ) : activeView === "devices" ? (
              <DevicesView
                db={db}
                me={me}
                workspace={wsState.workspace}
                engine={session.engine}
                onIdentityChange={setMe}
                selectedDeviceId={selectedDeviceId}
              />
            ) : activeView === "transfers" ? (
              <TransfersView db={db} me={me} />
            ) : activeView === "mesh" ? (
              <MeshView db={db} />
            ) : activeView === "security" ? (
              <SecurityView workspace={wsState.workspace} me={me} />
            ) : (
              <ActivityPanel db={db} me={me} />
            )}

          </div>
        </main>

        <RightRail db={db} me={me} />
      </div>

      {pairOpen && (
        <div
          className="fixed inset-0 z-50 grid overflow-y-auto bg-black/40 p-3 sm:place-items-center sm:p-4"
          onMouseDown={() => setPairOpen(false)}
        >
          <div
            className="my-auto w-full max-w-3xl rounded-xl border border-border bg-card p-4 shadow-2xl sm:p-6"
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

function DevicesView(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  workspace: LocalWorkspace;
  engine: MeshEngine;
  onIdentityChange: (me: LocalIdentity) => void;
  selectedDeviceId: string | null;
}) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const deliveries = useLiveQuery(() => props.db.deliveries.toArray(), [props.db]) ?? [];
  const objects = useLiveQuery(() => props.db.objects.toArray(), [props.db]) ?? [];
  const selected = devices.find((device) => device.id === props.selectedDeviceId);
  const related = selected ? deliveries.filter((delivery) => delivery.sourceDeviceId === selected.id || delivery.destinationDeviceId === selected.id) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div>
        <h1 className="text-lg font-semibold">Devices</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Every device paired into this workspace.</p>
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
        {selected && (
          <section className="mb-5 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-md bg-muted text-foreground"><DeviceTypeIcon deviceType={selected.type} className="size-5" /></span>
              <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{selected.name}</h2><p className="mt-0.5 text-xs capitalize text-muted-foreground">{selected.type} · {selected.status}</p></div>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs font-medium">Recent transfers</p>
              {related.length === 0 ? <p className="mt-1 text-[11px] text-muted-foreground">No transfers recorded with this device yet.</p> : (
                <div className="mt-2 divide-y divide-border">
                  {related.slice(0, 5).map((delivery) => {
                    const object = objects.find((item) => item.id === delivery.objectId);
                    const isOutgoing = delivery.sourceDeviceId === selected.id;
                    return <div key={delivery.id} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="min-w-0 truncate"><span className="font-medium">{object?.type ?? "Payload"}</span> <span className="text-muted-foreground">{isOutgoing ? "sent" : "received"}</span></span><span className="shrink-0 capitalize text-muted-foreground">{delivery.status}</span></div>;
                  })}
                </div>
              )}
            </div>
          </section>
        )}
        <DevicesPanel {...props} />
      </div>
    </div>
  );
}

function TransfersView(props: { db: ScreenMeshDb; me: LocalIdentity }) {
  // `createdAt` is intentionally not an IndexedDB key on the original
  // delivery store, so sort the small local result in memory. Ordering the
  // table by it throws a Dexie SchemaError and used to blank this route.
  const deliveries = useLiveQuery(() => props.db.deliveries.toArray().then((rows) => rows.sort((a, b) => b.createdAt - a.createdAt)), [props.db]) ?? [];
  const objects = useLiveQuery(() => props.db.objects.toArray(), [props.db]) ?? [];
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const outbox = useLiveQuery(() => props.db.outbox.toArray(), [props.db]) ?? [];
  const carried = useLiveQuery(() => props.db.carried.toArray(), [props.db]) ?? [];
  const nameOf = (id: string) => id === props.me.deviceId ? "This device" : devices.find((device) => device.id === id)?.name ?? "Unknown device";

  return <div className="flex h-full min-h-0 flex-col"><div className="flex items-start justify-between gap-4"><div><h1 className="text-xl font-semibold tracking-[-0.02em]">Transfers</h1><p className="mt-1 text-xs text-muted-foreground">Delivery state across your mesh.</p></div><span className="rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">{deliveries.length} total</span></div><div className="mt-5 grid shrink-0 gap-3 sm:grid-cols-3"><TransferMetric label="Awaiting route" value={String(outbox.length)} tone="text-warning" /><TransferMetric label="Carrying" value={String(carried.length)} tone="text-info" /><TransferMetric label="Pending approval" value={String(deliveries.filter((delivery) => delivery.status === "pending").length)} tone="text-warning" /></div><div className="mt-6 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card"><div className="divide-y divide-border">{deliveries.length === 0 ? <EmptyPanel text="No transfers yet" detail="Objects you send and receive will show their delivery state here." /> : deliveries.map((delivery) => { const object = objects.find((item) => item.id === delivery.objectId); const outgoing = delivery.sourceDeviceId === props.me.deviceId; return <div key={delivery.id} className="flex items-center gap-3 px-4 py-3"><span className={`size-2 rounded-full ${delivery.status === "delivered" || delivery.status === "opened" ? "bg-success" : delivery.status === "queued" || delivery.status === "pending" ? "bg-warning" : "bg-muted-foreground/45"}`} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium capitalize">{object?.type ?? "Payload"}</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{outgoing ? "To" : "From"} {nameOf(outgoing ? delivery.destinationDeviceId : delivery.sourceDeviceId)} · {new Date(delivery.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span><span className="shrink-0 rounded bg-muted px-2 py-1 text-[10px] capitalize text-muted-foreground">{delivery.status}</span></div>; })}</div></div></div>;
}

function TransferMetric({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="rounded-lg border border-border bg-card p-3"><p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 text-xl font-semibold ${tone}`}>{value}</p></div>; }

function MeshView(props: { db: ScreenMeshDb }) {
  const outbox = useLiveQuery(() => props.db.outbox.toArray(), [props.db]) ?? [];
  const carried = useLiveQuery(() => props.db.carried.toArray(), [props.db]) ?? [];
  const events = useLiveQuery(() => props.db.events.orderBy("timestamp").reverse().limit(8).toArray(), [props.db]) ?? [];
  return <div className="flex h-full min-h-0 flex-col"><div><h1 className="text-xl font-semibold tracking-[-0.02em]">Mesh</h1><p className="mt-1 text-xs text-muted-foreground">Connectivity and eventual-delivery state on this device.</p></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><section className="rounded-lg border border-border bg-card p-4"><p className="text-xs font-semibold">Route strategy</p><div className="mt-4 space-y-3"><RouteStatus active label="Direct connection" detail="WebRTC is tried before the relay." /><RouteStatus active label="Encrypted relay" detail="Available as the online fallback." /><RouteStatus label="Eventual delivery" detail={`${outbox.length} encrypted bundle${outbox.length === 1 ? "" : "s"} waiting locally.`} /></div></section><section className="rounded-lg border border-border bg-card p-4"><p className="text-xs font-semibold">Store–carry–forward</p><p className="mt-2 text-[11px] leading-5 text-muted-foreground">This device is holding {carried.length} opaque bundle{carried.length === 1 ? "" : "s"} for trusted destinations. Carriers cannot decrypt their contents.</p><div className="mt-4 flex items-center gap-2 text-[11px]"><span className="rounded bg-info/10 px-2 py-1 text-info">{carried.length} carrying</span><span className="rounded bg-warning/10 px-2 py-1 text-warning">{outbox.length} queued</span></div></section></div><section className="mt-5 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card"><div className="border-b border-border px-4 py-3"><p className="text-xs font-semibold">Recent mesh events</p></div>{events.length === 0 ? <EmptyPanel text="No mesh events yet" detail="Route and delivery events will appear as this device uses the mesh." /> : <div className="divide-y divide-border">{events.map((event) => <div key={event.id} className="flex gap-3 px-4 py-3"><span className={`mt-1.5 size-2 rounded-full ${event.category === "network" ? "bg-info" : event.category === "transfer" ? "bg-warning" : "bg-success"}`} /><span><span className="block text-xs font-medium">{event.title}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{event.detail}</span></span></div>)}</div>}</section></div>;
}

function SecurityView(props: { workspace: LocalWorkspace; me: LocalIdentity }) {
  const expires = props.workspace.expiresAt ? new Date(props.workspace.expiresAt).toLocaleString() : "Never";
  return <div className="flex h-full min-h-0 flex-col"><div><h1 className="text-xl font-semibold tracking-[-0.02em]">Security</h1><p className="mt-1 text-xs text-muted-foreground">Local trust and encryption posture for this workspace.</p></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><SecurityCard title="End-to-end encrypted" detail="Object content is encrypted before it leaves a device. Relays route ciphertext only." /><SecurityCard title="Forward-secret sessions" detail="Paired devices use Ed25519 identity and per-pair X25519/Double Ratchet sessions." /><SecurityCard title="Workspace expiry" detail={expires === "Never" ? "This workspace does not expire automatically." : `This workspace expires ${expires}.`} /><SecurityCard title="Workspace owner" detail={props.workspace.ownerDeviceId === props.me.deviceId ? "This device can pair and revoke devices." : "Only the workspace owner can pair and revoke devices."} /></div><div className="mt-5 rounded-lg border border-border bg-muted/35 p-4 text-[11px] leading-5 text-muted-foreground"><span className="font-medium text-foreground">Privacy boundary.</span> ScreenMesh does not expose plaintext payloads to the relay or a carrying device. Diagnostic views can only show local metadata and opaque encrypted bundle state.</div></div>;
}

function SecurityCard({ title, detail }: { title: string; detail: string }) { return <section className="rounded-lg border border-border bg-card p-4"><div className="flex items-center gap-2 text-xs font-semibold"><LockIcon className="size-4" />{title}</div><p className="mt-2 text-[11px] leading-5 text-muted-foreground">{detail}</p></section>; }
function EmptyPanel({ text, detail }: { text: string; detail: string }) { return <div className="grid place-items-center px-4 py-16 text-center"><div><p className="text-sm font-medium">{text}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div></div>; }

function Sidebar(props: {
  db: ScreenMeshDb;
  me: LocalIdentity;
  activeView: WorkspaceView;
  onNavigate: (view: WorkspaceView, deviceId?: string) => void;
}) {
  const devices = useLiveQuery(() => props.db.devices.toArray(), [props.db]) ?? [];
  const online = devices.filter((d) => d.status === "online").length;

  return (
    <aside className="hidden min-h-0 border-r border-border bg-card/35 p-3 md:flex md:flex-col">
      <nav className="space-y-1">
        <NavItem active={props.activeView === "workspace"} icon={<InboxIcon />} label="Workspace" onClick={() => props.onNavigate("workspace")} />
        <NavItem active={props.activeView === "library"} icon={<ActivityIcon />} label="Library" onClick={() => props.onNavigate("library")} />
        <NavItem active={props.activeView === "transfers"} icon={<ArrowUpIcon />} label="Transfers" onClick={() => props.onNavigate("transfers")} />
        <NavItem active={props.activeView === "devices"} icon={<DevicesIcon />} label="Devices" count={String(devices.length)} onClick={() => props.onNavigate("devices")} />
        <NavItem active={props.activeView === "mesh"} icon={<ActivityIcon />} label="Mesh" onClick={() => props.onNavigate("mesh")} />
        <NavItem active={props.activeView === "activity"} icon={<ActivityIcon />} label="Activity" onClick={() => props.onNavigate("activity")} />
        <NavItem active={props.activeView === "security"} icon={<LockIcon />} label="Security" onClick={() => props.onNavigate("security")} />
      </nav>
      <div className="mt-7 flex items-baseline justify-between px-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Devices</h2>
        <span className="text-[10px] text-muted-foreground">{online} online</span>
      </div>
      <p className="mt-1 px-2 text-[11px] text-muted-foreground">{devices.length} paired devices</p>
      <div className="mt-2 space-y-0.5 overflow-y-auto">
        {devices.length === 0 ? (
          <p className="px-1.5 text-[11px] text-muted-foreground">No devices paired yet.</p>
        ) : (
          devices.map((device) => {
            const isCurrent = device.id === props.me.deviceId;
            return (
            <button key={device.id} type="button" onClick={() => props.onNavigate("devices", device.id)} className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-accent ${isCurrent ? "bg-accent" : ""}`}>
              <span className={`grid size-8 shrink-0 place-items-center rounded-md ${isCurrent ? "bg-background text-foreground" : "bg-muted text-muted-foreground"}`}>
                <DeviceTypeIcon deviceType={device.type} className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{device.name}</span>
                <span className="block truncate text-[10px] capitalize text-muted-foreground">
                  {isCurrent ? "This device" : device.role} <span className="normal-case">·</span> {device.status === "online" ? "Online" : "Offline"}
                </span>
              </span>
              <span className={`size-1.5 shrink-0 rounded-full ${device.status === "online" ? "bg-success" : "bg-muted-foreground/45"}`} />
            </button>
            );
          })
        )}
      </div>
      <div className="mt-auto border-t border-border px-2 pt-4">
        <div className="flex items-center justify-between text-[10px]"><span className="text-muted-foreground">Local storage</span><span className="font-mono">Encrypted</span></div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full w-[34%] rounded-full bg-foreground" /></div>
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Local-first and end-to-end encrypted. No account connected.
        </p>
      </div>
    </aside>
  );
}

function MobileNavigation(props: { activeView: WorkspaceView; onNavigate: (view: WorkspaceView) => void }) {
  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1.5 md:hidden" aria-label="Workspace navigation">
      <MobileNavItem active={props.activeView === "workspace"} icon={<InboxIcon />} label="Workspace" onClick={() => props.onNavigate("workspace")} />
      <MobileNavItem active={props.activeView === "library"} icon={<ActivityIcon />} label="Library" onClick={() => props.onNavigate("library")} />
      <MobileNavItem active={props.activeView === "transfers"} icon={<ArrowUpIcon />} label="Transfers" onClick={() => props.onNavigate("transfers")} />
      <MobileNavItem active={props.activeView === "devices"} icon={<DevicesIcon />} label="Devices" onClick={() => props.onNavigate("devices")} />
      <MobileNavItem active={props.activeView === "mesh"} icon={<ActivityIcon />} label="Mesh" onClick={() => props.onNavigate("mesh")} />
      <MobileNavItem active={props.activeView === "activity"} icon={<ActivityIcon />} label="Activity" onClick={() => props.onNavigate("activity")} />
      <MobileNavItem active={props.activeView === "security"} icon={<LockIcon />} label="Security" onClick={() => props.onNavigate("security")} />
    </nav>
  );
}

function MobileNavItem({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex min-w-16 shrink-0 flex-1 flex-col items-center gap-1 rounded-md py-1.5 text-[10px] transition-colors ${active ? "bg-accent font-medium text-foreground" : "text-muted-foreground"}`}>
      <span className="[&_svg]:size-4">{icon}</span>{label}
    </button>
  );
}

function NavItem({ icon, label, count, active, onClick }: { icon: React.ReactNode; label: string; count?: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs ${active ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
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
    <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-card/25 p-5 xl:block">
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
        <div className="mt-4 space-y-3 border-l border-border pl-4">
          {carried.map((bundle) => (
            <div key={bundle.bundleId} className="rounded-lg border border-border bg-card p-3 shadow-[0_1px_2px_oklch(0_0_0/.03)]">
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

      <div className="mt-8">
        <h2 className="text-xs font-semibold">Route strategy</h2>
        <div className="mt-3 space-y-3 text-[11px]">
          <RouteStatus active label="Direct connection" detail="WebRTC when a peer is reachable" />
          <RouteStatus active label="Encrypted relay" detail="Secure fallback when direct is unavailable" />
          <RouteStatus label="Eventual delivery" detail="Queues locally until a trusted route opens" />
        </div>
      </div>

      <div className="mt-8 border-t border-border pt-4">
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

function RouteStatus({ label, detail, active = false }: { label: string; detail: string; active?: boolean }) {
  return <div className="flex items-start gap-2"><span className={`mt-1 size-1.5 rounded-full ${active ? "bg-success" : "bg-muted-foreground/35"}`} /><span><span className="block">{label}</span><span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">{detail}</span></span></div>;
}
