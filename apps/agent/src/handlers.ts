import { exec as execCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execCallback);
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Runs a shell command and returns its output. Used both for "command"
 * objects (a raw string a human sent) and the "run_command" agent_task
 * action (a structured request, potentially from another agent). Every
 * call site gates this behind explicit user approval first — see
 * index.ts's promptApproval — this function itself does not ask.
 */
export async function runShell(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec(command, { timeout: COMMAND_TIMEOUT_MS });
    return stdout || stderr || "(no output)";
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export type TaskHandler = (params: Record<string, unknown> | undefined) => Promise<string>;

/**
 * agent_task handler registry (docs/Roadmap.md Phase 5 — agent-to-agent
 * structured task channel). Deliberately small: a few illustrative
 * handlers proving the pattern, not a general plugin system. Every
 * handler here touches something sensitive (shell, filesystem), so
 * index.ts gates ALL of them behind the same approval prompt as command
 * objects — never auto-executed (docs/Security.md §8).
 */
export const TASK_HANDLERS: Record<string, TaskHandler> = {
  echo: async (params) => String(params?.text ?? ""),

  read_file: async (params) => {
    const path = params?.path;
    if (typeof path !== "string") {
      throw new Error('read_file requires a string "path" param');
    }
    return readFile(path, "utf-8");
  },

  run_command: async (params) => {
    const command = params?.command;
    if (typeof command !== "string") {
      throw new Error('run_command requires a string "command" param');
    }
    return runShell(command);
  },
};
