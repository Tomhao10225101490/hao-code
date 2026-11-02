// Permission gate: the human stays in charge of anything that changes state.
//
// Read-only tools (read_file, search, list_files) are auto-approved. Tools that
// write files or execute commands must be confirmed interactively, showing a
// summary of exactly what will happen. The user can approve once, deny, or
// allow a tool for the rest of the session. A `--yes` flag (autoApprove)
// disables prompting entirely — off by default.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { unifiedDiff } from "./diff.js";
import type { Tool } from "./tools/index.js";

/** Cap on diff lines shown in an approval prompt. */
const MAX_DIFF_LINES = 80;

/** Truncate a diff for display, keeping whole lines. */
function capDiff(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= MAX_DIFF_LINES) return diff;
  return (
    lines.slice(0, MAX_DIFF_LINES).join("\n") +
    `\n  ... [diff truncated: ${lines.length - MAX_DIFF_LINES} more lines]`
  );
}

/** Indent every line of a block for display inside a prompt. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

export type AskFn = (prompt: string) => Promise<string>;

export interface PermissionGateOptions {
  /** Approve everything without asking. Set by the CLI's --yes flag. */
  autoApprove?: boolean;
  /** How to ask the user. If absent and approval is needed, the action is denied. */
  ask?: AskFn;
  /** Where summaries are printed. Defaults to stdout via console.log. */
  log?: (text: string) => void;
}

export class PermissionGate {
  private readonly sessionAllowed = new Set<string>();
  private readonly autoApprove: boolean;
  private readonly ask?: AskFn;
  private readonly log: (text: string) => void;

  constructor(opts: PermissionGateOptions = {}) {
    this.autoApprove = opts.autoApprove ?? false;
    this.ask = opts.ask;
    this.log = opts.log ?? ((t) => console.log(t));
  }

  async approve(
    tool: Tool,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<boolean> {
    if (!tool.requiresApproval) return true;
    if (this.autoApprove) return true;
    const name = tool.def.function.name;
    if (this.sessionAllowed.has(name)) return true;
    if (!this.ask) return false; // No way to ask -> safe default is "no".

    this.log(`\n${summarizeRequest(name, args, cwd)}`);
    const answer = (
      await this.ask("Allow? [y]es / [n]o / [a]lways for this tool this session: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") {
      this.sessionAllowed.add(name);
      return true;
    }
    return answer === "y" || answer === "yes";
  }
}

/**
 * The unified diff a write_file/edit_file call would produce, computed from
 * the file's current on-disk content. Returns undefined for other tools,
 * when the file cannot be read, when an edit is not unambiguous, or when
 * there is no change. Used both by the approval prompt (before the action)
 * and by the CLI's post-approval diff reveal (after it is applied).
 */
export function diffPreviewFor(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (toolName === "write_file") {
    const rel = String(args.path ?? "");
    const full = path.resolve(cwd, rel);
    const content = typeof args.content === "string" ? args.content : "";
    let oldContent = "";
    let exists = false;
    if (existsSync(full)) {
      exists = true;
      try {
        oldContent = readFileSync(full, "utf8");
      } catch {
        oldContent = "";
      }
    }
    const diff = unifiedDiff(oldContent, content, {
      oldLabel: exists ? `a/${rel}` : "/dev/null",
      newLabel: `b/${rel}`,
    });
    return diff === "" ? undefined : diff;
  }
  if (toolName === "edit_file") {
    const rel = String(args.path ?? "");
    const full = path.resolve(cwd, rel);
    const oldText = typeof args.old_text === "string" ? args.old_text : "";
    const newText = typeof args.new_text === "string" ? args.new_text : "";
    if (oldText === "") return undefined;
    let current: string;
    try {
      current = readFileSync(full, "utf8");
    } catch {
      return undefined;
    }
    const at = current.indexOf(oldText);
    const unique = at >= 0 && current.indexOf(oldText, at + 1) === -1;
    if (!unique) return undefined;
    const updated =
      current.slice(0, at) + newText + current.slice(at + oldText.length);
    const diff = unifiedDiff(current, updated, {
      oldLabel: `a/${rel}`,
      newLabel: `b/${rel}`,
    });
    return diff === "" ? undefined : diff;
  }
  return undefined;
}

/** Build a human-readable preview of what a tool is about to do. */
export function summarizeRequest(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  switch (toolName) {
    case "write_file": {
      const rel = String(args.path ?? "");
      const full = path.resolve(cwd, rel);
      const content = typeof args.content === "string" ? args.content : "";
      const newLines = content === "" ? 0 : content.split("\n").length;
      const exists = existsSync(full);
      const headline = exists
        ? `write_file -> ${rel} (overwrite, ${newLines} lines)`
        : `write_file -> ${rel} (new file: ${newLines} lines)`;
      const diff = diffPreviewFor(toolName, args, cwd);
      return diff
        ? `${headline}\n${indent(capDiff(diff))}`
        : `${headline}\n  (content is unchanged)`;
    }
    case "edit_file": {
      const rel = String(args.path ?? "");
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      // When the edit is unambiguous, preview the real resulting diff.
      const diff = diffPreviewFor(toolName, args, cwd);
      if (diff) return `edit_file -> ${rel}\n${indent(capDiff(diff))}`;
      const show = (text: string, sign: string): string =>
        text
          .split("\n")
          .slice(0, 8)
          .map((l) => `  ${sign} ${l}`)
          .join("\n");
      return [`edit_file -> ${rel}`, show(oldText, "-"), show(newText, "+")].join("\n");
    }
    case "git_commit": {
      const message = typeof args.message === "string" ? args.message : "";
      return [
        "git_commit (stages ALL changes: git add -A)",
        `  message: ${message}`,
      ].join("\n");
    }
    case "run_command": {
      const timeout =
        typeof args.timeout_ms === "number" ? ` (timeout ${args.timeout_ms}ms)` : "";
      return `run_command${timeout}\n  $ ${String(args.command ?? "")}`;
    }
    default: {
      const json = JSON.stringify(args);
      return `${toolName} ${json.length > 200 ? json.slice(0, 200) + "..." : json}`;
    }
  }
}
