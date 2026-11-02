// Tests for the app server (hao-code app): static UI, config/session APIs,
// and a full SSE turn with the permission bridge — approved and denied.
// Uses the same scripted fake provider as the agent tests; the only network
// involved is loopback HTTP to the server under test.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ResolvedSettings } from "../src/config.js";
import type {
  ChatResponse,
  Message,
  Provider,
  ToolDef,
  TokenHandler,
} from "../src/provider.js";
import { maskApiKey, startAppServer, type RunningAppServer } from "../src/server.js";

/** A provider that plays back a fixed script of assistant messages. */
class FakeProvider implements Provider {
  readonly name = "fake";
  private index = 0;

  constructor(private readonly script: Message[]) {}

  async chat(
    _messages: Message[],
    _tools: ToolDef[],
    onToken?: TokenHandler,
  ): Promise<ChatResponse> {
    const message = this.script[this.index++];
    if (!message) throw new Error("FakeProvider: script exhausted");
    if (message.content) onToken?.(message.content);
    return { message };
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

const settings: ResolvedSettings = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "sk-test-secret-1234",
  model: "fake-model",
  autoApprove: false,
  trace: true,
};

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function startTestServer(cwd: string): Promise<RunningAppServer> {
  return startAppServer({
    settings,
    cwd,
    provider: new FakeProvider(writeHelloScript()),
    port: 0,
    sessionsDir: tempDir("hao-code-sessions-"),
    approvalTimeoutMs: 10_000,
    version: "9.9.9-test",
  });
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** POST one turn and collect its SSE events, reacting to each as it arrives. */
async function runTurn(
  base: string,
  message: string,
  onEvent: (ev: SseEvent) => Promise<void> | void,
): Promise<SseEvent[]> {
  const res = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(res.body, "turn response should have a stream body");

  const events: SseEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const ev = JSON.parse(line.slice("data:".length).trim()) as SseEvent;
      events.push(ev);
      await onEvent(ev);
    }
  }
  return events;
}

async function approve(base: string, id: string, answer: string): Promise<void> {
  const res = await fetch(`${base}/api/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, answer }),
  });
  assert.equal(res.status, 200);
  await res.text();
}

test("maskApiKey never returns the full key", () => {
  assert.equal(maskApiKey(undefined), null);
  assert.equal(maskApiKey(""), null);
  assert.equal(maskApiKey("abc"), "••••");
  const masked = maskApiKey("sk-test-secret-1234");
  assert.ok(masked);
  assert.ok(!masked.includes("test-secret"));
  assert.notEqual(masked, "sk-test-secret-1234");
});

test("app server serves the UI shell and the config/session APIs", async () => {
  const running = await startTestServer(tempDir("hao-code-app-"));
  try {
    const home = await fetch(`${running.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    const html = await home.text();
    assert.match(html, /hao-code/);
    assert.match(html, /id="composer"/);
    assert.match(html, /id="sessionList"/);

    const css = await fetch(`${running.url}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
    await css.text();

    const js = await fetch(`${running.url}/app.js`);
    assert.equal(js.status, 200);
    await js.text();

    const configRes = await fetch(`${running.url}/api/config`);
    assert.equal(configRes.status, 200);
    const config = (await configRes.json()) as Record<string, unknown>;
    assert.equal(config.model, "fake-model");
    assert.equal(config.provider, "openai-compatible");
    assert.equal(config.version, "9.9.9-test");
    assert.equal(config.trace, true);
    assert.ok(
      typeof config.apiKeyMasked === "string" &&
        !config.apiKeyMasked.includes("test-secret"),
      "config must mask the API key",
    );
    assert.equal(config.apiKey, undefined, "config must not expose the raw key");

    const sessionsRes = await fetch(`${running.url}/api/sessions`);
    assert.equal(sessionsRes.status, 200);
    const sessions = (await sessionsRes.json()) as { sessions: unknown[] };
    assert.ok(Array.isArray(sessions.sessions));
    assert.equal(sessions.sessions.length, 0);

    const missing = await fetch(`${running.url}/nope`);
    assert.equal(missing.status, 404);
    await missing.text();
  } finally {
    await running.close();
  }
});

test("app server turn: permission request approved over HTTP writes the file", async () => {
  const dir = tempDir("hao-code-app-");
  const running = await startTestServer(dir);
  try {
    let sawBusyConflict = false;
    const events = await runTurn(running.url, "Please create hello.txt", async (ev) => {
      if (ev.type !== "permission_request") return;
      assert.equal(ev.tool, "write_file");
      assert.match(String(ev.summary), /write_file/);
      assert.match(String(ev.diff), /\+hello from test/);

      // While this turn waits on approval, a second turn must be refused.
      const conflict = await fetch(`${running.url}/api/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "another turn" }),
      });
      assert.equal(conflict.status, 409);
      await conflict.text();
      sawBusyConflict = true;

      await approve(running.url, String(ev.id), "y");
    });

    assert.ok(sawBusyConflict, "expected a permission_request during the turn");
    const types = events.map((e) => e.type);
    assert.ok(types.includes("tool_call"), `events: ${types.join(",")}`);
    assert.ok(types.includes("permission_request"));
    assert.ok(types.includes("turn_end"));
    assert.equal(types[types.length - 1], "done");

    const toolResult = events.find((e) => e.type === "tool_result");
    assert.ok(toolResult);
    assert.equal(toolResult.ok, true);

    const file = path.join(dir, "hello.txt");
    assert.ok(existsSync(file), "approved write should land on disk");
    assert.equal(readFileSync(file, "utf8"), "hello from test\n");

    // The finished turn persisted a session the API can list.
    const sessionsRes = await fetch(`${running.url}/api/sessions`);
    const sessions = (await sessionsRes.json()) as { sessions: unknown[] };
    assert.equal(sessions.sessions.length, 1);
  } finally {
    await running.close();
  }
});

test("app server turn: a denied permission request writes nothing", async () => {
  const dir = tempDir("hao-code-app-");
  const running = await startTestServer(dir);
  try {
    const events = await runTurn(running.url, "Please create hello.txt", async (ev) => {
      if (ev.type === "permission_request") {
        await approve(running.url, String(ev.id), "n");
      }
    });

    const types = events.map((e) => e.type);
    assert.ok(types.includes("permission_request"));
    assert.equal(types[types.length - 1], "done");

    const toolResult = events.find((e) => e.type === "tool_result");
    assert.ok(toolResult);
    assert.equal(toolResult.ok, false);
    assert.match(String(toolResult.result), /Permission denied/);
    assert.ok(
      !existsSync(path.join(dir, "hello.txt")),
      "denied write must not create the file",
    );
  } finally {
    await running.close();
  }
});

test("app server rejects an approval for an unknown id", async () => {
  const running = await startTestServer(tempDir("hao-code-app-"));
  try {
    const res = await fetch(`${running.url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "appr-999", answer: "y" }),
    });
    assert.equal(res.status, 404);
    await res.text();

    const badAnswer = await fetch(`${running.url}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "appr-1", answer: "maybe" }),
    });
    assert.equal(badAnswer.status, 400);
    await badAnswer.text();
  } finally {
    await running.close();
  }
});
