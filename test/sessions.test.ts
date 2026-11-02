// Tests for session serialization, persistence, and listing.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Message } from "../src/provider.js";
import {
  latestSessionPath,
  listSessions,
  loadSession,
  parseSession,
  saveSession,
  serializeSession,
} from "../src/sessions.js";

function sampleHistory(): Message[] {
  return [
    { role: "system", content: "You are hao-code." },
    { role: "user", content: "create hello.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "write_file",
            arguments: '{"path":"hello.txt","content":"hi"}',
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Wrote 2 bytes to hello.txt." },
    { role: "assistant", content: "Done." },
  ];
}

test("session serialize/parse round-trips the full history", () => {
  const history = sampleHistory();
  const parsed = parseSession(serializeSession(history, "/some/dir"));
  assert.deepEqual(parsed, history);
});

test("parseSession also accepts a bare message array", () => {
  const history = sampleHistory();
  const parsed = parseSession(JSON.stringify(history));
  assert.deepEqual(parsed, history);
});

test("parseSession rejects garbage", () => {
  assert.throws(() => parseSession("not json"), /not valid JSON/);
  assert.throws(() => parseSession('{"nope":true}'), /does not contain/);
  assert.throws(
    () => parseSession('[{"role":"banana","content":"x"}]'),
    /invalid role/,
  );
});

test("save, list, latest, and load work on disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hao-code-sessions-"));
  const history = sampleHistory();

  const first = path.join(dir, "2026-01-01T00-00-00-000Z.json");
  const second = path.join(dir, "2026-01-02T00-00-00-000Z.json");
  saveSession(first, history, "/work");
  saveSession(second, [...history, { role: "user", content: "more" }], "/work");

  assert.deepEqual(loadSession(first), history);

  const listed = listSessions(dir);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((s) => s.sizeBytes > 0));
  // Most recently written should sort first (or at least be findable).
  assert.ok(listed.some((s) => s.path === second));
  assert.ok(latestSessionPath(dir) !== undefined);

  assert.deepEqual(listSessions(path.join(dir, "missing")), []);
  assert.equal(latestSessionPath(path.join(dir, "missing")), undefined);
});
