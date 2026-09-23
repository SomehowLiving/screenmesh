import { useEffect, useState } from "react";
import type { MeshEngine } from "@screenmesh/sync";

const POLL_MS = 3_000;
const HEARTBEAT_MS = 4_000;

/**
 * Ephemeral "who else has this object's editor open" — a UX safeguard, not
 * a lock (nothing here stops anyone from editing). `active` reflects
 * whether THIS device's own editor is open right now; heartbeats only go
 * out while it's true. The returned array is every OTHER device currently
 * believed to be editing, independent of `active`, so a viewer sees the
 * warning before they've even clicked Edit — that's the point, since the
 * underlying Yjs merge can't fully protect a peer's first edit on an
 * object it never got seeded Yjs state for (see engine.ts's editText doc
 * comment for that gap).
 */
export function useEditingPresence(engine: MeshEngine, objectId: string, active: boolean): string[] {
  const [others, setOthers] = useState<string[]>(() => engine.editingPresenceFor(objectId));

  useEffect(() => {
    const poll = () => setOthers(engine.editingPresenceFor(objectId));
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [engine, objectId]);

  useEffect(() => {
    if (!active) return;
    void engine.setEditingPresence(objectId, true);
    const heartbeat = setInterval(() => void engine.setEditingPresence(objectId, true), HEARTBEAT_MS);
    return () => {
      clearInterval(heartbeat);
      void engine.setEditingPresence(objectId, false);
    };
  }, [engine, objectId, active]);

  return others;
}
