import { useState } from "react";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { MeshMark } from "./mesh-icons.js";

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
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <MeshMark className="size-8" />
          <h1 className="mt-4 text-2xl font-semibold">ScreenMesh</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your devices. One encrypted mesh. No account, no cloud, no central server.
          </p>
        </div>

        {(props.error ?? error) && (
          <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {props.error ?? error}
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <section className="rounded-lg border border-border bg-card p-5 shadow-[0_1px_2px_oklch(0_0_0/.04)]">
            <h2 className="text-sm font-semibold">Create a workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              This device becomes the owner and can pair others via QR or link.
            </p>
            <div className="mt-4 space-y-3">
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">Expires</span>
                <SelectMenu
                  className="flex-1"
                  ariaLabel="Workspace expiration"
                  value={String(ttlIndex)}
                  onValueChange={(value) => setTtlIndex(Number(value))}
                  options={TTL_CHOICES.map((choice, index) => ({ value: String(index), label: choice.label }))}
                />
              </div>
              <Button
                className="w-full"
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
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5 shadow-[0_1px_2px_oklch(0_0_0/.04)]">
            <h2 className="text-sm font-semibold">Join a workspace</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Scan the owner's QR with your camera, or paste the join link or code below.
            </p>
            <div className="mt-4 space-y-3">
              <textarea
                placeholder="Paste join link or pairing code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                variant="outline"
                className="w-full"
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
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
