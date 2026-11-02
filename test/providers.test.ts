// Tests for the two providers: Anthropic message conversion, plus streaming
// response parsing for both providers against local throwaway HTTP servers
// (no external network involved).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Message, ToolDef } from "../src/provider.js";
import {
  AnthropicProvider,
  toAnthropicMessages,
  toAnthropicTools,
} from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

const writeFileDef: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

function history(): Message[] {
  return [
    { role: "system", content: "You are hao-code." },
    { role: "user", content: "create x.txt" },
    {
      role: "assistant",
      content: "Writing it.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: '{"path":"x.txt","content":"hi"}',
          },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"x.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Wrote 2 bytes." },
    { role: "tool", tool_call_id: "call_2", content: "1 | hi" },
    { role: "assistant", content: "Done." },
  ];
}

test("toAnthropicMessages separates system and merges tool results", () => {
  const { system, messages } = toAnthropicMessages(history());
  assert.equal(system, "You are hao-code.");
  assert.equal(messages.length, 4);

  assert.deepEqual(messages[0], { role: "user", content: "create x.txt" });

  const assistant = messages[1];
  assert.equal(assistant.role, "assistant");
  assert.ok(Array.isArray(assistant.content));
  const blocks = assistant.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[1].type, "tool_use");
  assert.equal(blocks[1].id, "call_1");
  assert.deepEqual(blocks[1].input, { path: "x.txt", content: "hi" });
  assert.equal(blocks[2].type, "tool_use");

  // Both tool results merged into ONE user message.
  const results = messages[2];
  assert.equal(results.role, "user");
  const resultBlocks = results.content as Array<Record<string, unknown>>;
  assert.equal(resultBlocks.length, 2);
  assert.equal(resultBlocks[0].type, "tool_result");
  assert.equal(resultBlocks[0].tool_use_id, "call_1");
  assert.equal(resultBlocks[1].tool_use_id, "call_2");

  assert.deepEqual(messages[3], { role: "assistant", content: [{ type: "text", text: "Done." }] });

  const tools = toAnthropicTools([writeFileDef]);
  assert.equal(tools[0].name, "write_file");
  assert.deepEqual(tools[0].input_schema, writeFileDef.function.parameters);
});

interface CapturedRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function serveOnce(
  respond: (req: CapturedRequest, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; base: string; captured: CapturedRequest }> {
  const captured: CapturedRequest = { headers: {}, body: "" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      captured.url = req.url;
      captured.headers = req.headers;
      captured.body = body;
      respond(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, captured };
}

test("Anthropic provider parses streamed text, tool calls, and usage", async () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"x.txt\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
  ].join("\n\n");

  const { server, base, captured } = await serveOnce((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse);
  });
  try {
    const provider = new AnthropicProvider({
      baseURL: base,
      apiKey: "sk-ant-test",
      model: "claude-test",
    });
    const tokens: string[] = [];
    const response = await provider.chat(history(), [writeFileDef], (t) =>
      tokens.push(t),
    );

    assert.equal(tokens.join(""), "Hello");
    assert.equal(response.message.content, "Hello");
    assert.equal(response.message.tool_calls?.length, 1);
    const call = response.message.tool_calls?.[0];
    assert.equal(call?.id, "toolu_1");
    assert.equal(call?.function.name, "write_file");
    assert.deepEqual(JSON.parse(call?.function.arguments ?? "{}"), { path: "x.txt" });
    assert.deepEqual(response.usage, {
      inputTokens: 25,
      outputTokens: 42,
      totalTokens: 67,
    });

    // Request shape: right URL, auth headers, system separated, tools converted.
    assert.equal(captured.url, "/v1/messages");
    assert.equal(captured.headers["x-api-key"], "sk-ant-test");
    assert.equal(captured.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    assert.equal(body.system, "You are hao-code.");
    assert.equal(body.model, "claude-test");
    assert.equal(body.stream, true);
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0].name, "write_file");
    assert.ok(tools[0].input_schema);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible provider captures usage from the final chunk", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x.txt\\"}"}}]}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  const { server, base, captured } = await serveOnce((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse);
  });
  try {
    const provider = new OpenAICompatibleProvider({
      baseURL: `${base}/v1`,
      apiKey: "test-key",
      model: "test-model",
    });
    const response = await provider.chat(history(), [writeFileDef]);
    assert.equal(response.message.content, "Hi");
    const call = response.message.tool_calls?.[0];
    assert.equal(call?.function.name, "write_file");
    assert.deepEqual(JSON.parse(call?.function.arguments ?? "{}"), { path: "x.txt" });
    assert.deepEqual(response.usage, {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });

    const body = JSON.parse(captured.body) as Record<string, unknown>;
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(captured.headers.authorization, "Bearer test-key");
  } finally {
    server.close();
  }
});
