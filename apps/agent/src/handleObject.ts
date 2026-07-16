import type { MeshEngine } from "@screenmesh/sync";
import type { AgentTaskContent, MeshObject, TextContent } from "@screenmesh/protocol";
import { runShell, TASK_HANDLERS } from "./handlers.js";

/** Ask for approval before running anything (docs/Security.md §8). The
 *  CLI wires this to a readline prompt; tests inject an automated one. */
export type ApprovalFn = (description: string) => Promise<boolean>;

/**
 * Core "command"/"agent_task" handling, shared by the interactive CLI
 * (index.ts) and the automated smoke test (scripts/agent-smoke.ts) — the
 * only difference between them is what `approve` does.
 */
export async function handleIncomingObject(
  engine: MeshEngine,
  approve: ApprovalFn,
  object: MeshObject,
  senderId: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  if (object.type === "command") {
    const { text } = object.content as TextContent;
    await engine.markOpened(object.id);
    const approved = await approve(`Incoming command from ${senderId}:\n\n  ${text}\n`);
    if (!approved) {
      await engine.sendObject(
        { type: "text", content: { text: "Command was rejected on the receiving device." } },
        [senderId],
      );
      log("Rejected — not executed.");
      return;
    }
    const output = await runShell(text);
    await engine.sendObject({ type: "text", content: { text: output } }, [senderId]);
    log("Executed; result sent back.");
    return;
  }

  if (object.type === "agent_task") {
    const { action, params } = object.content as AgentTaskContent;
    await engine.markOpened(object.id);
    const handler = TASK_HANDLERS[action];
    if (!handler) {
      await engine.sendObject(
        { type: "text", content: { text: `No handler for action "${action}" on this agent.` } },
        [senderId],
      );
      log(`Unknown agent_task action "${action}" — told the sender.`);
      return;
    }
    const approved = await approve(
      `Incoming agent task from ${senderId}: ${action}(${JSON.stringify(params ?? {})})\n`,
    );
    if (!approved) {
      await engine.sendObject(
        { type: "text", content: { text: `Task "${action}" was rejected.` } },
        [senderId],
      );
      log("Rejected — not run.");
      return;
    }
    try {
      const result = await handler(params);
      await engine.sendObject({ type: "text", content: { text: result } }, [senderId]);
      log(`Task "${action}" completed; result sent back.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await engine.sendObject(
        { type: "text", content: { text: `Task "${action}" failed: ${message}` } },
        [senderId],
      );
      log(`Task "${action}" failed: ${message}`);
    }
  }
}
