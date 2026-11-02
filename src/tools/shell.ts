import { exec } from "node:child_process";
import type { Tool } from "./index.js";
import { optionalInt, requireString, truncateOutput } from "./util.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

export const runCommandTool: Tool = {
  requiresApproval: true,
  def: {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the working directory and return its combined stdout/stderr " +
        "and exit code. Commands run non-interactively; do not start editors, REPLs, or servers " +
        "that never exit. Default timeout is 120 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          timeout_ms: { type: "integer", minimum: 1, description: "Optional timeout in milliseconds." },
        },
        required: ["command"],
      },
    },
  },
  async run(args, ctx) {
    const command = requireString(args, "command");
    const timeout = optionalInt(args, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;

    const { code, signal, stdout, stderr } = await new Promise<{
      code: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      exec(
        command,
        { cwd: ctx.cwd, timeout, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ code: 0, signal: null, stdout, stderr });
          } else {
            resolve({
              code: typeof err.code === "number" ? err.code : null,
              signal: err.signal ?? null,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            });
          }
        },
      );
    });

    const timedOut = signal === "SIGTERM" && code === null;
    const header =
      `exit code: ${code === null ? "killed" : code}` +
      (timedOut ? ` (timed out after ${timeout}ms)` : "") +
      (signal && !timedOut ? ` (signal ${signal})` : "");
    const body = [stdout.trimEnd(), stderr ? `[stderr]\n${stderr.trimEnd()}` : ""]
      .filter((s) => s.length > 0)
      .join("\n");
    return truncateOutput(`${header}\n${body || "(no output)"}`, MAX_OUTPUT_CHARS);
  },
};
