// The agent loop: the heart of hao-code.
//
// runTurn() appends the user's message, then repeatedly asks the provider for
// the next assistant message. If the message requests tool calls, each call is
// checked by the permission gate, executed, and its result appended — until
// the model replies with plain text (done) or a step cap is hit.
//
// When a session file is set, the full history is written to it after every
// turn (see sessions.ts), so the conversation can be resumed later.

import { buildSystemPrompt } from "./context.js";
import type { PermissionGate } from "./permissions.js";
import {
  addUsage,
  type Message,
  type Provider,
  type TokenUsage,
  type ToolCall,
} from "./provider.js";
import { saveSession } from "./sessions.js";
import { allToolDefs, getTool, toolRegistry } from "./tools/index.js";

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "step"; step: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; result: string }
  | { type: "max_steps"; steps: number }
  | { type: "turn_end"; steps: number; usage?: TokenUsage };

/**
 * Event handlers may be async: the loop awaits step/tool/turn events (via
 * Promise.resolve on the handler's return value) so a UI can finish
 * rendering — e.g. a diff reveal — before work continues. Token events are
 * the exception: they fire synchronously while the provider streams and
 * are never awaited. The declared return type stays `void` so simple
 * handlers like `(e) => events.push(e)` remain assignable.
 */
export type AgentEventHandler = (event: AgentEvent) => void;

export const MAX_STEPS = 25;

export class Agent {
  private history: Message[] = [];
  private sessionFile: string | undefined;

  constructor(
    private readonly provider: Provider,
    private readonly gate: PermissionGate,
    private readonly cwd: string,
    private readonly onEvent: AgentEventHandler = () => {},
  ) {
    this.reset();
  }

  /** Start a fresh conversation (system prompt only). */
  reset(): void {
    this.history = [{ role: "system", content: buildSystemPrompt(this.cwd) }];
  }

  getHistory(): readonly Message[] {
    return this.history;
  }

  /**
   * Replace the conversation with a loaded history (session resume). If the
   * stored history has no system message, a fresh one is prepended so the
   * agent still knows how to work in the current directory.
   */
  loadHistory(messages: Message[]): void {
    if (messages.length > 0 && messages[0].role === "system") {
      this.history = [...messages];
    } else {
      this.history = [
        { role: "system", content: buildSystemPrompt(this.cwd) },
        ...messages,
      ];
    }
  }

  /** Persist the history to this file after every turn. */
  setSessionFile(file: string | undefined): void {
    this.sessionFile = file;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  private persist(): void {
    if (!this.sessionFile) return;
    try {
      saveSession(this.sessionFile, this.history, this.cwd);
    } catch {
      // A failed save must never break the conversation itself.
    }
  }

  /** Run one user turn to completion; resolves with the final assistant text. */
  async runTurn(userText: string): Promise<string> {
    this.history.push({ role: "user", content: userText });
    let usage: TokenUsage | undefined;
    let stepsUsed = 0;

    try {
      for (let step = 1; step <= MAX_STEPS; step++) {
        stepsUsed = step;
        await this.onEvent({ type: "step", step });
        const response = await this.provider.chat(
          this.history,
          allToolDefs(),
          (t) => this.onEvent({ type: "token", text: t }),
        );
        usage = addUsage(usage, response.usage);
        const reply = response.message;
        this.history.push(reply);

        const calls = reply.tool_calls ?? [];
        if (calls.length === 0) {
          await this.onEvent({ type: "turn_end", steps: stepsUsed, usage });
          return reply.content ?? "";
        }
        for (const call of calls) {
          await this.executeToolCall(call);
        }
        if (step === MAX_STEPS) {
          await this.onEvent({ type: "max_steps", steps: MAX_STEPS });
        }
      }
      await this.onEvent({ type: "turn_end", steps: stepsUsed, usage });
      return "";
    } finally {
      this.persist();
    }
  }

  private async executeToolCall(call: ToolCall): Promise<void> {
    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<
        string,
        unknown
      >;
    } catch {
      const result = `Error: the tool call arguments were not valid JSON: ${call.function.arguments}`;
      await this.onEvent({ type: "tool_result", name, ok: false, result });
      this.history.push({ role: "tool", tool_call_id: call.id, content: result });
      return;
    }

    await this.onEvent({ type: "tool_call", name, args });
    let result: string;
    let ok = true;

    const tool = getTool(name);
    let approved = false;
    if (tool) {
      try {
        approved = await this.gate.approve(tool, args, this.cwd);
      } catch (err) {
        // A broken prompt mechanism must fail closed, not crash the turn.
        result = `Error: the permission check failed: ${err instanceof Error ? err.message : String(err)}`;
        await this.onEvent({ type: "tool_result", name, ok: false, result });
        this.history.push({ role: "tool", tool_call_id: call.id, content: result });
        return;
      }
    }
    if (!tool) {
      result = `Error: unknown tool "${name}". Available tools: ${Object.keys(toolRegistry).join(", ")}.`;
      ok = false;
    } else if (!approved) {
      result =
        "Permission denied by the user. Do not retry this exact action; " +
        "ask how they would like to proceed.";
      ok = false;
    } else {
      try {
        result = await tool.run(args, { cwd: this.cwd });
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        ok = false;
      }
    }

    if (result.startsWith("Error:")) ok = false;
    await this.onEvent({ type: "tool_result", name, ok, result });
    this.history.push({ role: "tool", tool_call_id: call.id, content: result });
  }
}
