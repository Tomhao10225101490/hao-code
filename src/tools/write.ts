import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./index.js";
import { requireString } from "./util.js";

export const writeFileTool: Tool = {
  requiresApproval: true,
  def: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or completely overwrite an existing file with the given content. " +
        "Parent directories are created as needed. For small changes to existing files, prefer edit_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory unless absolute." },
          content: { type: "string", description: "The full file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args, ctx) {
    const rel = requireString(args, "path");
    const content = args.content;
    if (typeof content !== "string") {
      throw new Error('Missing or invalid "content" argument: expected a string.');
    }
    const full = path.resolve(ctx.cwd, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    const lines = content === "" ? 0 : content.split("\n").length;
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes (${lines} lines) to ${rel}.`;
  },
};
