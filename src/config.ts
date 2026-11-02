// Configuration: an optional JSON file at ~/.config/hao-code/config.json,
// overridden by environment variables, overridden by CLI flags.
//
// Precedence (highest first):
//   1. CLI flags (e.g. --yes)
//   2. Environment variables (AGENT_*, ANTHROPIC_*; also a local .env file)
//   3. ~/.config/hao-code/config.json
//   4. Built-in defaults (local Ollama, no key needed)

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProviderKind = "openai-compatible" | "anthropic";

export interface HaoCodeConfig {
  provider?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  autoApprove?: boolean;
  /** Print the structured step-by-step trace feed after each agent step. */
  trace?: boolean;
}

/** Absolute path of the config file for the given environment. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? os.homedir(), ".config");
  return path.join(configHome, "hao-code", "config.json");
}

export interface LoadedConfig {
  config: HaoCodeConfig;
  path: string;
  /** Set when the file exists but could not be parsed/validated. */
  error?: string;
}

const KNOWN_KEYS = ["provider", "baseUrl", "apiKey", "model", "autoApprove", "trace"];

/** Read and validate the config file. A missing file is not an error. */
export function loadConfigFile(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const file = configFilePath(env);
  if (!existsSync(file)) return { config: {}, path: file };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      config: {},
      path: file,
      error: `could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: {}, path: file, error: `${file} must contain a JSON object` };
  }

  const raw = parsed as Record<string, unknown>;
  const config: HaoCodeConfig = {};
  for (const key of KNOWN_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (key === "autoApprove" || key === "trace") {
      if (typeof value !== "boolean") {
        return { config: {}, path: file, error: `${file}: "${key}" must be a boolean` };
      }
      config[key] = value;
    } else if (key === "provider") {
      if (value !== "openai-compatible" && value !== "anthropic") {
        return {
          config: {},
          path: file,
          error: `${file}: "provider" must be "openai-compatible" or "anthropic"`,
        };
      }
      config.provider = value;
    } else {
      if (typeof value !== "string") {
        return { config: {}, path: file, error: `${file}: "${key}" must be a string` };
      }
      config[key as "baseUrl" | "apiKey" | "model"] = value;
    }
  }
  return { config, path: file };
}

/** Fully resolved settings used to build a provider. */
export interface ResolvedSettings {
  provider: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
  autoApprove: boolean;
  /** Trace mode: AGENT_TRACE=1/true, or "trace": true in the config file. */
  trace: boolean;
}

export const DEFAULT_OPENAI_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Decide which provider to use: AGENT_PROVIDER wins, then the config file,
 * then auto-detection (an ANTHROPIC_API_KEY implies Anthropic), then the
 * local-first OpenAI-compatible default.
 */
export function resolveSettings(
  env: NodeJS.ProcessEnv,
  fileConfig: HaoCodeConfig,
): ResolvedSettings {
  let provider: ProviderKind;
  if (env.AGENT_PROVIDER === "anthropic" || env.AGENT_PROVIDER === "openai-compatible") {
    provider = env.AGENT_PROVIDER;
  } else if (fileConfig.provider) {
    provider = fileConfig.provider;
  } else if (env.ANTHROPIC_API_KEY) {
    provider = "anthropic";
  } else {
    provider = "openai-compatible";
  }

  const autoApprove =
    fileConfig.autoApprove === true ||
    env.AGENT_AUTO_APPROVE === "1" ||
    env.AGENT_AUTO_APPROVE === "true";

  const trace =
    env.AGENT_TRACE === "1" ||
    env.AGENT_TRACE === "true" ||
    fileConfig.trace === true;

  if (provider === "anthropic") {
    return {
      provider,
      baseUrl:
        env.ANTHROPIC_BASE_URL ??
        env.AGENT_BASE_URL ??
        fileConfig.baseUrl ??
        DEFAULT_ANTHROPIC_BASE_URL,
      apiKey: env.ANTHROPIC_API_KEY ?? env.AGENT_API_KEY ?? fileConfig.apiKey,
      model:
        env.ANTHROPIC_MODEL ??
        env.AGENT_MODEL ??
        fileConfig.model ??
        DEFAULT_ANTHROPIC_MODEL,
      autoApprove,
      trace,
    };
  }

  return {
    provider,
    baseUrl: env.AGENT_BASE_URL ?? fileConfig.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
    apiKey: env.AGENT_API_KEY ?? fileConfig.apiKey ?? "ollama",
    model: env.AGENT_MODEL ?? fileConfig.model ?? DEFAULT_OPENAI_MODEL,
    autoApprove,
    trace,
  };
}
