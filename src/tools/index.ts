// Tool registry: maps tool names to their definitions and executors.
//
// The agent loop looks tools up here; the permission gate reads
// `requiresApproval` to decide whether to prompt the user.

import type { ToolDef } from "../provider.js";
import { editFileTool } from "./edit.js";
import { gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool } from "./git.js";
import { readFileTool } from "./read.js";
import { listFilesTool, searchTool } from "./search.js";
import { runCommandTool } from "./shell.js";
import { writeFileTool } from "./write.js";

export interface ToolContext {
  /** Directory that relative tool paths resolve against. */
  cwd: string;
}

export interface Tool {
  def: ToolDef;
  /** True for tools that change state (write/edit/shell) and need approval. */
  requiresApproval: boolean;
  /**
   * Execute the tool. Returns text for the model; throws an Error with an
   * actionable message on failure (the agent turns it into a tool result).
   */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const toolRegistry: Record<string, Tool> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  run_command: runCommandTool,
  search: searchTool,
  list_files: listFilesTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_log: gitLogTool,
  git_commit: gitCommitTool,
};

/** Tool definitions in the shape the provider sends to the model. */
export function allToolDefs(): ToolDef[] {
  return Object.values(toolRegistry).map((t) => t.def);
}

export function getTool(name: string): Tool | undefined {
  return toolRegistry[name];
}
