// Anthropic provider: speaks the native Messages API (not the
// OpenAI-compatible shim), built on native fetch like the other providers.
//
// Internal hao-code messages are converted to Anthropic's shape: the system
// prompt is a top-level field, assistant tool calls become `tool_use` content
// blocks, and tool results become `tool_result` blocks inside a user message.

import type {
  ChatResponse,
  Message,
  Provider,
  TokenUsage,
  ToolCall,
  ToolDef,
  TokenHandler,
} from "../provider.js";

export interface AnthropicOptions {
  /** e.g. "https://api.anthropic.com" — "/v1/messages" is appended. */
  baseURL: string;
  apiKey?: string;
  model: string;
  /** Required by the Messages API. Defaults to 4096. */
  maxTokens?: number;
}

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the empty object below.
  }
  return {};
}

/**
 * Convert internal messages to Anthropic's format. Consecutive tool results
 * are merged into a single user message, as the API expects.
 */
export function toAnthropicMessages(messages: Message[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let pendingResults: AnthropicContentBlock[] = [];

  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: m.content ?? "",
      });
      continue;
    }
    flushResults();
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
      continue;
    }
    // assistant
    const blocks: AnthropicContentBlock[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const call of m.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
      });
    }
    out.push({
      role: "assistant",
      content: blocks.length > 0 ? blocks : (m.content ?? ""),
    });
  }
  flushResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/** Convert internal tool definitions to Anthropic's `tools` array. */
export function toAnthropicTools(tools: ToolDef[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(private readonly opts: AnthropicOptions) {}

  get model(): string {
    return this.opts.model;
  }

  get baseURL(): string {
    return this.opts.baseURL;
  }

  async chat(
    messages: Message[],
    tools: ToolDef[],
    onToken?: TokenHandler,
  ): Promise<ChatResponse> {
    const base = this.opts.baseURL.replace(/\/+$/, "");
    const url = `${base}/v1/messages`;
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.opts.apiKey ?? "",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: anthropicMessages,
          tools: tools.length > 0 ? toAnthropicTools(tools) : undefined,
          stream: true,
        }),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach the Anthropic API at ${url} (${detail}).\n` +
          `Check your network connection, or set AGENT_PROVIDER=openai-compatible to use a local server instead.`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Anthropic API returned ${res.status} ${res.statusText}` +
          (body ? `: ${body.slice(0, 500)}` : "") +
          `\n(endpoint: ${url}, model: ${this.opts.model})` +
          (res.status === 401
            ? `\nHint: the API key was rejected — check ANTHROPIC_API_KEY.`
            : ""),
      );
    }
    if (!res.body) {
      throw new Error(`Anthropic API at ${url} returned an empty response body.`);
    }

    // Parse the SSE stream. Each event's JSON payload carries its `type`,
    // so only the "data:" lines are needed.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const calls = new Map<number, ToolCallAccumulator>();

    const handlePayload = (payload: string): void => {
      let event: StreamEvent;
      try {
        event = JSON.parse(payload) as StreamEvent;
      } catch {
        return; // Ignore malformed keep-alive fragments.
      }
      switch (event.type) {
        case "message_start": {
          const u = event.message?.usage;
          if (u) {
            inputTokens = u.input_tokens;
            outputTokens = u.output_tokens;
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block?.type === "tool_use" && typeof event.index === "number") {
            calls.set(event.index, {
              id: block.id ?? "",
              name: block.name ?? "",
              arguments: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (!delta) break;
          if (delta.type === "text_delta" && delta.text) {
            content += delta.text;
            onToken?.(delta.text);
          } else if (
            delta.type === "input_json_delta" &&
            typeof event.index === "number"
          ) {
            const acc = calls.get(event.index);
            if (acc && delta.partial_json) acc.arguments += delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (event.usage?.output_tokens !== undefined) {
            outputTokens = event.usage.output_tokens;
          }
          if (event.usage?.input_tokens !== undefined) {
            inputTokens = event.usage.input_tokens;
          }
          break;
        }
        case "error": {
          throw new Error(
            `Anthropic API stream error: ${event.error?.message ?? "unknown error"}`,
          );
        }
        default:
          break;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) {
          handlePayload(line.slice("data:".length).trim());
        }
        nl = buffer.indexOf("\n");
      }
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc], i) => ({
        id: acc.id || `call_${i}`,
        type: "function" as const,
        function: { name: acc.name, arguments: acc.arguments || "{}" },
      }));

    const usage: TokenUsage | undefined =
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            inputTokens,
            outputTokens,
            totalTokens:
              inputTokens !== undefined || outputTokens !== undefined
                ? (inputTokens ?? 0) + (outputTokens ?? 0)
                : undefined,
          }
        : undefined;

    return {
      message: {
        role: "assistant",
        content: content === "" ? null : content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      ...(usage ? { usage } : {}),
    };
  }
}

/** Build an Anthropic provider from ANTHROPIC_* / AGENT_* environment variables. */
export function anthropicFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicProvider {
  return new AnthropicProvider({
    baseURL: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    apiKey: env.ANTHROPIC_API_KEY ?? env.AGENT_API_KEY,
    model: env.ANTHROPIC_MODEL ?? env.AGENT_MODEL ?? "claude-sonnet-4-5",
  });
}
