import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./index.js";
import { requireString } from "./util.js";

export const editFileTool: Tool = {
  requiresApproval: true,
  def: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact snippet of text in an existing file. old_text must appear exactly once " +
        "in the file (include enough surrounding context to make it unique) and must match exactly, " +
        "including whitespace and indentation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory unless absolute." },
          old_text: { type: "string", description: "The exact text to replace." },
          new_text: { type: "string", description: "The replacement text." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  async run(args, ctx) {
    const rel = requireString(args, "path");
    const oldText = requireString(args, "old_text");
    const newText = args.new_text;
    if (typeof newText !== "string") {
      throw new Error('Missing or invalid "new_text" argument: expected a string.');
    }
    const full = path.resolve(ctx.cwd, rel);
    const original = await readFile(full, "utf8");
    const count = original.split(oldText).length - 1;
    if (count === 0) {
      throw new Error(
        `old_text was not found in ${rel}. It must match exactly, including whitespace. ` +
          `Read the file first and copy the text precisely.`,
      );
    }
    if (count > 1) {
      throw new Error(
        `old_text must appear exactly once in ${rel}, but it appears ${count} times. ` +
          `Add more surrounding context to make it unique.`,
      );
    }
    const at = original.indexOf(oldText);
    const updated =
      original.slice(0, at) + newText + original.slice(at + oldText.length);
    await writeFile(full, updated, "utf8");
    return `Edited ${rel}: replaced ${oldText.split("\n").length} line(s) with ${newText === "" ? 0 : newText.split("\n").length} line(s).`;
  },
};
