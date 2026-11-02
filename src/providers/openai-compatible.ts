// OpenAI-compatible chat-completions provider, built on native fetch.
//
// Works with any server that speaks the OpenAI chat-completions API with
// streaming: Ollama (the default, local, no key needed), OpenAI itself,
// LM Studio, llama.cpp server, most hosted gateways, and so on.

import type {
  ChatResponse,
  Message,
  Provider,
  TokenUsage,
  ToolCall,
  ToolDef,
  TokenHandler,
} from "../provider.js";

export interface OpenAICompatibleOptions {
  /** e.g. "http://localhost:11434/v1" — the "/chat/completions" path is appended. */
  baseURL: string;
  /** Bearer token. Local servers like Ollama ignore it. */
  apiKey?: string;
  model: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";

  constructor(private readonly opts: OpenAICompatibleOptions) {}

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
    const url = `${this.opts.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.apiKey) {
      headers["Authorization"] = `Bearer ${this.opts.apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          // Ask for a final usage chunk; servers that do not support it
          // (older Ollama) simply never send one, and usage stays undefined.
          stream_options: { include_usage: true },
        }),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach the model server at ${url} (${detail}).\n` +
          `If you are using the local default, is Ollama running? Start it with: ollama serve\n` +
          `Or point AGENT_BASE_URL at a reachable OpenAI-compatible endpoint.`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Model server returned ${res.status} ${res.statusText}` +
          (body ? `: ${body.slice(0, 500)}` : "") +
          `\n(endpoint: ${url}, model: ${this.opts.model})`,
      );
    }
    if (!res.body) {
      throw new Error(`Model server at ${url} returned an empty response body.`);
    }

    // Parse the SSE stream: lines of "data: {json}", terminated by "data: [DONE]".
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: TokenUsage | undefined;
    const calls = new Map<number, ToolCallAccumulator>();

    const handlePayload = (payload: string): void => {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        return; // Ignore malformed keep-alive fragments.
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        let acc = calls.get(tc.index);
        if (!acc) {
          acc = { id: "", name: "", arguments: "" };
          calls.set(tc.index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
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
          const payload = line.slice("data:".length).trim();
          if (payload !== "[DONE]") handlePayload(payload);
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

/** Build a provider from AGENT_* environment variables (local Ollama by default). */
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseURL: env.AGENT_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: env.AGENT_API_KEY ?? "ollama",
    model: env.AGENT_MODEL ?? "qwen2.5-coder:7b",
  });
}
