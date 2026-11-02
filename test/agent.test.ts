// Tests for the agent loop and tools, using a scripted fake provider —
// no model server or network needed.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent.js";
import { PermissionGate } from "../src/permissions.js";
import type {
  ChatResponse,
  Message,
  Provider,
  TokenUsage,
  ToolDef,
  TokenHandler,
} from "../src/provider.js";
import { editFileTool } from "../src/tools/edit.js";
import { readFileTool } from "../src/tools/read.js";

/** A provider that plays back a fixed script of assistant messages. */
class FakeProvider implements Provider {
  readonly name = "fake";
  private index = 0;

  constructor(
    private readonly script: Message[],
    private readonly usages: Array<TokenUsage | undefined> = [],
  ) {}

  async chat(
    _messages: Message[],
    _tools: ToolDef[],
    onToken?: TokenHandler,
  ): Promise<ChatResponse> {
    const i = this.index++;
    const message = this.script[i];
    if (!message) throw new Error("FakeProvider: script exhausted");
    if (message.content) onToken?.(message.content);
    const usage = this.usages[i];
    return usage ? { message, usage } : { message };
  }
}

function writeHelloScript(): Message[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: "hello.txt",
              content: "hello from test\n",
            }),
          },
        },
      ],
    },
    { role: "assistant", content: "Done — I created hello.txt." },
  ];
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hao-code-test-"));
}

test("agent executes a write_file tool call and returns the final reply", async () => {
  const dir = tempDir();
  const tokens: string[] = [];
  const agent = new Agent(
    new FakeProvider(writeHelloScript()),
    new PermissionGate({ autoApprove: true }),
    dir,
    (event) => {
      if (event.type === "token") tokens.push(event.text);
    },
  );

  const reply = await agent.runTurn("Please create hello.txt");

  assert.equal(reply, "Done — I created hello.txt.");
  const file = path.join(dir, "hello.txt");
  assert.ok(existsSync(file), "hello.txt should have been created");
  assert.equal(readFileSync(file, "utf8"), "hello from test\n");
  assert.equal(tokens.join(""), "Done — I created hello.txt.");

  const toolResult = agent.getHistory().find((m) => m.role === "tool");
  assert.ok(toolResult, "history should contain a tool result");
  assert.match(toolResult.content ?? "", /Wrote 16 bytes/);
});

test("agent reports a denied permission instead of writing the file", async () => {
  const dir = tempDir();
  const gate = new PermissionGate({
    ask: async () => "n",
    log: () => {},
  });
  const agent = new Agent(new FakeProvider(writeHelloScript()), gate, dir);

  const reply = await agent.runTurn("Please create hello.txt");

  assert.equal(reply, "Done — I created hello.txt.");
  assert.ok(
    !existsSync(path.join(dir, "hello.txt")),
    "file must not be created when permission is denied",
  );
  const toolResult = agent.getHistory().find((m) => m.role === "tool");
  assert.match(toolResult?.content ?? "", /Permission denied/);
});

test("read_file returns numbered lines and honors a range", async () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
  const ctx = { cwd: dir };

  const all = await readFileTool.run({ path: "a.txt" }, ctx);
  assert.match(all, /1 \| alpha/);
  assert.match(all, /3 \| gamma/);

  const range = await readFileTool.run(
    { path: "a.txt", start_line: 2, end_line: 2 },
    ctx,
  );
  assert.match(range, /2 \| beta/);
  assert.ok(!range.includes("alpha"));
});

test("agent aggregates provider usage and emits a turn_end summary", async () => {
  const dir = tempDir();
  const events: AgentEvent[] = [];
  const agent = new Agent(
    new FakeProvider(writeHelloScript(), [
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
    ]),
    new PermissionGate({ autoApprove: true }),
    dir,
    (event) => events.push(event),
  );

  await agent.runTurn("Please create hello.txt");

  const turnEnd = events.find((e) => e.type === "turn_end");
  assert.ok(turnEnd && turnEnd.type === "turn_end");
  assert.equal(turnEnd.steps, 2);
  assert.deepEqual(turnEnd.usage, {
    inputTokens: 30,
    outputTokens: 12,
    totalTokens: 42,
  });
});

test("edit_file replaces a unique match and rejects duplicates", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\ntwo\n");
  const ctx = { cwd: dir };

  const out = await editFileTool.run(
    { path: "a.txt", old_text: "one", new_text: "1" },
    ctx,
  );
  assert.match(out, /Edited a\.txt/);
  assert.equal(readFileSync(file, "utf8"), "1\ntwo\ntwo\n");

  await assert.rejects(
    () => editFileTool.run({ path: "a.txt", old_text: "two", new_text: "2" }, ctx),
    /exactly once/,
  );
  await assert.rejects(
    () =>
      editFileTool.run({ path: "a.txt", old_text: "missing", new_text: "x" }, ctx),
    /not found/,
  );
});
