// Git tools: read-only inspection (status/diff/log) plus commit, which
// stages all changes and therefore goes through the permission gate like any
// other write-class action. All of them fail with a clear message when run
// outside a git repository.

import { execFile } from "node:child_process";
import type { Tool } from "./index.js";
import { optionalInt, requireString, truncateOutput } from "./util.js";

const MAX_OUTPUT_CHARS = 20_000;

/** Run git with the given args in `cwd`; rejects with git's stderr on failure. */
export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim();
          reject(new Error(`git ${args[0]} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Throw a friendly error unless `cwd` is inside a git work tree. */
async function ensureRepo(cwd: string): Promise<void> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    if (out.trim() !== "true") throw new Error("not a work tree");
  } catch {
    throw new Error(
      "Not a git repository (or git is not installed). " +
        "Git tools only work inside a project under git version control.",
    );
  }
}

export const gitStatusTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "git_status",
      description:
        "Show the git working tree status: current branch, staged, unstaged, and untracked files.",
      parameters: { type: "object", properties: {} },
    },
  },
  async run(_args, ctx) {
    await ensureRepo(ctx.cwd);
    const out = await runGit(["status", "--short", "--branch"], ctx.cwd);
    return truncateOutput(out.trim() === "" ? "(clean working tree)" : out.trimEnd(), MAX_OUTPUT_CHARS);
  },
};

export const gitDiffTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Show git changes as a unified diff. By default shows unstaged changes; " +
        "pass staged=true for the staged (index) changes.",
      parameters: {
        type: "object",
        properties: {
          staged: { type: "boolean", description: "Show staged changes instead of unstaged." },
        },
      },
    },
  },
  async run(args, ctx) {
    await ensureRepo(ctx.cwd);
    const staged = args.staged === true;
    const out = await runGit(staged ? ["diff", "--staged"] : ["diff"], ctx.cwd);
    return truncateOutput(
      out.trim() === "" ? "(no changes)" : out.trimEnd(),
      MAX_OUTPUT_CHARS,
    );
  },
};

export const gitLogTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "git_log",
      description: "Show the most recent git commits (hash, date, author, subject).",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "How many commits to show. Default 10.",
          },
        },
      },
    },
  },
  async run(args, ctx) {
    await ensureRepo(ctx.cwd);
    const count = optionalInt(args, "count") ?? 10;
    const out = await runGit(
      ["log", `--max-count=${count}`, "--pretty=format:%h %ad %an %s", "--date=short"],
      ctx.cwd,
    );
    return truncateOutput(out.trim() === "" ? "(no commits yet)" : out.trimEnd(), MAX_OUTPUT_CHARS);
  },
};

export const gitCommitTool: Tool = {
  requiresApproval: true,
  def: {
    type: "function",
    function: {
      name: "git_commit",
      description:
        "Stage ALL changes in the working tree (git add -A) and create a commit " +
        "with the given message. Asks the user for permission first. Do not commit " +
        "unless the user asked for it or the work is clearly finished.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "The commit message." },
        },
        required: ["message"],
      },
    },
  },
  async run(args, ctx) {
    const message = requireString(args, "message");
    await ensureRepo(ctx.cwd);
    await runGit(["add", "-A"], ctx.cwd);
    const out = await runGit(["commit", "-m", message], ctx.cwd);
    return out.trimEnd();
  },
};
