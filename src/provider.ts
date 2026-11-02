// Shared types for model providers.
//
// The agent loop only ever talks to the `Provider` interface defined here, so
// new backends (hosted APIs, other local servers) can be added without touching
// the loop.

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Raw JSON string of the arguments object, as produced by the model. */
    arguments: string;
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant messages that request tool executions. */
  tool_calls?: ToolCall[];
  /** Present on tool messages: the id of the call this message answers. */
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema object describing the arguments. */
    parameters: Record<string, unknown>;
  };
}

/** Token counts for one provider response, when the backend reports them. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** What a provider returns for one chat call: the message plus usage info. */
export interface ChatResponse {
  message: Message;
  /** Present only when the backend reports token usage. */
  usage?: TokenUsage;
}

export type TokenHandler = (token: string) => void;

export interface Provider {
  readonly name: string;
  /**
   * Send the conversation and tool definitions to the model.
   * Streams text tokens to `onToken` as they arrive and resolves with the
   * complete assistant message (text and/or tool calls) plus token usage
   * when the backend reports it.
   */
  chat(
    messages: Message[],
    tools: ToolDef[],
    onToken?: TokenHandler,
  ): Promise<ChatResponse>;
}

/** Sum two usage records field-by-field (either side may be missing). */
export function addUsage(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
}
