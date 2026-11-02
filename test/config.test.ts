// Tests for the config file loader and settings precedence.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  configFilePath,
  loadConfigFile,
  resolveSettings,
} from "../src/config.js";

function envWithConfig(config: unknown): NodeJS.ProcessEnv {
  const home = mkdtempSync(path.join(tmpdir(), "hao-code-config-"));
  const dir = path.join(home, "hao-code");
  mkdirSync(dir, { recursive: true });
  if (config !== undefined) {
    writeFileSync(
      path.join(dir, "config.json"),
      typeof config === "string" ? config : JSON.stringify(config),
    );
  }
  return { XDG_CONFIG_HOME: home };
}

test("configFilePath points into the XDG config home", () => {
  const env = envWithConfig(undefined);
  assert.equal(
    configFilePath(env),
    path.join(env.XDG_CONFIG_HOME as string, "hao-code", "config.json"),
  );
});

test("a missing config file is empty, not an error", () => {
  const loaded = loadConfigFile(envWithConfig(undefined));
  assert.deepEqual(loaded.config, {});
  assert.equal(loaded.error, undefined);
});

test("config file values are loaded and validated", () => {
  const loaded = loadConfigFile(
    envWithConfig({ provider: "anthropic", model: "claude-x", autoApprove: true }),
  );
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.config.provider, "anthropic");
  assert.equal(loaded.config.model, "claude-x");
  assert.equal(loaded.config.autoApprove, true);
});

test("invalid JSON and invalid values produce an error, not a crash", () => {
  const badJson = loadConfigFile(envWithConfig("{oops"));
  assert.ok(badJson.error);
  assert.deepEqual(badJson.config, {});

  const badProvider = loadConfigFile(envWithConfig({ provider: "wat" }));
  assert.ok(badProvider.error);
});

test("defaults are the local Ollama settings", () => {
  const s = resolveSettings({}, {});
  assert.equal(s.provider, "openai-compatible");
  assert.equal(s.baseUrl, "http://localhost:11434/v1");
  assert.equal(s.model, "qwen2.5-coder:7b");
  assert.equal(s.autoApprove, false);
});

test("config file beats defaults, environment beats the file", () => {
  const fromFile = resolveSettings(
    {},
    { baseUrl: "http://file:1/v1", model: "file-model" },
  );
  assert.equal(fromFile.baseUrl, "http://file:1/v1");
  assert.equal(fromFile.model, "file-model");

  const fromEnv = resolveSettings(
    { AGENT_BASE_URL: "http://env:2/v1", AGENT_MODEL: "env-model" },
    { baseUrl: "http://file:1/v1", model: "file-model" },
  );
  assert.equal(fromEnv.baseUrl, "http://env:2/v1");
  assert.equal(fromEnv.model, "env-model");
});

test("provider selection: explicit env, then file, then ANTHROPIC_API_KEY auto-detect", () => {
  assert.equal(
    resolveSettings({ AGENT_PROVIDER: "anthropic" }, { provider: "openai-compatible" }).provider,
    "anthropic",
  );
  assert.equal(
    resolveSettings({}, { provider: "anthropic" }).provider,
    "anthropic",
  );
  assert.equal(
    resolveSettings({ ANTHROPIC_API_KEY: "sk-ant-test" }, {}).provider,
    "anthropic",
  );
  const anthropic = resolveSettings({ ANTHROPIC_API_KEY: "sk-ant-test" }, {});
  assert.equal(anthropic.baseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.model, "claude-sonnet-4-5");
  assert.equal(anthropic.apiKey, "sk-ant-test");
});

test("trace mode resolves from AGENT_TRACE or the config file", () => {
  assert.equal(resolveSettings({}, {}).trace, false);
  assert.equal(resolveSettings({}, { trace: true }).trace, true);
  assert.equal(resolveSettings({ AGENT_TRACE: "1" }, {}).trace, true);
  assert.equal(resolveSettings({ AGENT_TRACE: "true" }, {}).trace, true);
  assert.equal(resolveSettings({ AGENT_TRACE: "0" }, {}).trace, false);
});

test("the config loader accepts a boolean trace and rejects other types", () => {
  const loaded = loadConfigFile(envWithConfig({ trace: true }));
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.config.trace, true);

  const bad = loadConfigFile(envWithConfig({ trace: "yes" }));
  assert.ok(bad.error);
});
