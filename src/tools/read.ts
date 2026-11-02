import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./index.js";
import { optionalInt, requireString, truncateOutput } from "./util.js";

const MAX_LINES = 2000;
const MAX_CHARS = 50_000;

export const readFileTool: Tool = {
  requiresApproval: false,
  def: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file and return its contents with line numbers. " +
        "Optionally restrict to a 1-based inclusive line range with start_line/end_line. " +
        "Paths are relative to the working directory unless absolute.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
          start_line: { type: "integer", minimum: 1, description: "First line (1-based)." },
          end_line: { type: "integer", minimum: 1, description: "Last line (1-based, inclusive)." },
        },
        required: ["path"],
      },
    },
  },
  async run(args, ctx) {
    const rel = requireString(args, "path");
    const full = path.resolve(ctx.cwd, rel);
    const text = await readFile(full, "utf8");
    const lines = text.split("\n");
    const start = Math.max(1, optionalInt(args, "start_line") ?? 1);
    const end = Math.min(lines.length, optionalInt(args, "end_line") ?? lines.length);
    if (start > end) {
      return `(no lines in requested range ${start}-${end}; file has ${lines.length} lines)`;
    }
    const slice = lines.slice(start - 1, end);
    const shown = slice.slice(0, MAX_LINES);
    const width = String(start + shown.length - 1).length;
    let out = shown
      .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
      .join("\n");
    if (slice.length > MAX_LINES) {
      out += `\n... [${slice.length - MAX_LINES} more lines not shown; use start_line/end_line to read a range]`;
    }
    return truncateOutput(out, MAX_CHARS) || "(empty file)";
  },
};
