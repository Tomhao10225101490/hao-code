import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Tool } from "./index.js";
import { requireString, truncateOutput } from "./util.js";

const MAX_MATCH_LINES = 200;
const MAX_RESULTS = 500;

// ---------------------------------------------------------------------------
// search: ripgrep if available, grep otherwise.
// ---------------------------------------------------------------------------

let ripgrepAvailable: boolean | null = null;
function hasRipgrep(): boolean {
  if (ripgrepAvailable === null) {
    try {
      ripgrepAvailable = spawnSync("rg", ["--version"]).status === 0;
    } catch {
      ripgrepAvailable = false;
    }
  }
  return ripgrepAvailable;
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          out: (stdout ?? "") + (stderr ?? ""),
        });
      },
    );
  });
}

export const searchTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "search",
      description:
        "Search file contents for a regular-expression pattern (ripgrep, or grep as a fallback). " +
        "Returns matching lines with file paths and line numbers. Skips binary files, node_modules, and .git.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "File or directory to search in (default: working directory)." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args, ctx) {
    const pattern = requireString(args, "pattern");
    const target = typeof args.path === "string" && args.path ? args.path : ".";
    const result = hasRipgrep()
      ? await runCapture(
          "rg",
          ["--line-number", "--no-heading", "--color", "never", "-e", pattern, target],
          ctx.cwd,
        )
      : await runCapture("grep", ["-rnI", "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", pattern, target], ctx.cwd);
    if (result.code === 1) {
      return `No matches for /${pattern}/ in ${target}.`;
    }
    if (result.code !== 0) {
      return `Search failed (exit ${result.code}):\n${truncateOutput(result.out.trim(), 4000)}`;
    }
    const lines = result.out.split("\n").filter((l) => l.length > 0);
    const shown = lines.slice(0, MAX_MATCH_LINES);
    let out = shown.join("\n");
    if (lines.length > MAX_MATCH_LINES) {
      out += `\n... [${lines.length - MAX_MATCH_LINES} more matching lines not shown; narrow the pattern or path]`;
    }
    return truncateOutput(out, 30_000);
  },
};

// ---------------------------------------------------------------------------
// list_files: glob-lite directory walk.
// ---------------------------------------------------------------------------

/** Convert a small glob ("**", "*", "?") into a RegExp over posix-style paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

interface IgnoreRule {
  regex: RegExp;
  hasSlash: boolean;
  dirOnly: boolean;
}

/** Minimal .gitignore support: plain names and globs; negations unsupported. */
function loadIgnoreRules(base: string): IgnoreRule[] {
  const file = path.join(base, ".gitignore");
  if (!existsSync(file)) return [];
  const rules: IgnoreRule[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ regex: globToRegExp(line), hasSlash: line.includes("/"), dirOnly });
  }
  return rules;
}

function isIgnored(rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) {
      // A "name/" rule also ignores everything under a directory of that name.
      if (!rule.hasSlash && rel.split("/").slice(0, -1).some((seg) => rule.regex.test(seg))) {
        return true;
      }
      continue;
    }
    if (rule.hasSlash) {
      if (rule.regex.test(rel)) return true;
    } else if (rel.split("/").some((seg) => rule.regex.test(seg))) {
      return true;
    }
  }
  return false;
}

export const listFilesTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files matching a glob pattern, e.g. \"src/**/*.ts\" or \"*.md\". " +
        "Always skips node_modules and .git; honors simple .gitignore rules. " +
        "An optional base path can be given (default: working directory).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match, relative to the base path." },
          path: { type: "string", description: "Base directory (default: working directory)." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args, ctx) {
    const pattern = requireString(args, "pattern");
    const baseRel = typeof args.path === "string" && args.path ? args.path : ".";
    const base = path.resolve(ctx.cwd, baseRel);
    if (!existsSync(base)) {
      throw new Error(`Directory not found: ${baseRel}`);
    }
    const matcher = globToRegExp(pattern);
    const matchBasename = !pattern.includes("/");
    const rules = loadIgnoreRules(base);
    const results: string[] = [];

    const walk = (dir: string, relPrefix: string, depth: number): void => {
      if (depth > 32 || results.length > MAX_RESULTS) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          if (isIgnored(rel, true, rules)) continue;
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          if (isIgnored(rel, false, rules)) continue;
          if (matcher.test(rel) || (matchBasename && matcher.test(entry.name))) {
            results.push(rel);
          }
        }
      }
    };
    walk(base, "", 0);

    results.sort();
    if (results.length === 0) return `No files match "${pattern}".`;
    const shown = results.slice(0, MAX_RESULTS);
    return (
      shown.join("\n") +
      (results.length > MAX_RESULTS
        ? `\n... [${results.length - MAX_RESULTS} more files not shown]`
        : "")
    );
  },
};
