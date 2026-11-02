// Session persistence: conversation history is saved as JSON under
// ~/.hao-code/sessions/<timestamp>.json after every turn, so a session can be
// resumed later with --continue (most recent) or --resume <file>.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "./provider.js";

/** Directory session files live in. */
export function sessionsDir(home: string = os.homedir()): string {
  return path.join(home, ".hao-code", "sessions");
}

/** A filesystem-safe timestamp name, e.g. "2026-11-02T03-15-30-123Z". */
export function sessionTimestampName(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Path for a brand-new session file. */
export function newSessionPath(dir: string = sessionsDir(), date: Date = new Date()): string {
  return path.join(dir, `${sessionTimestampName(date)}.json`);
}

export interface SessionFile {
  version: 1;
  app: "hao-code";
  savedAt: string;
  cwd: string;
  messages: Message[];
}

/** Serialize a conversation history to the on-disk JSON format. */
export function serializeSession(messages: readonly Message[], cwd: string): string {
  const file: SessionFile = {
    version: 1,
    app: "hao-code",
    savedAt: new Date().toISOString(),
    cwd,
    messages: messages.map((m) => ({ ...m })),
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a session file back into a history. Accepts both the wrapped
 * SessionFile format and a bare array of messages (forward compatibility).
 */
export function parseSession(text: string): Message[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Session file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as SessionFile | null)?.messages;
  if (!Array.isArray(raw)) {
    throw new Error("Session file does not contain a message history.");
  }
  const messages: Message[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const role = entry?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new Error(`Session file contains a message with invalid role: ${String(role)}`);
    }
    const content = entry.content;
    if (content !== null && typeof content !== "string") {
      throw new Error("Session file contains a message with invalid content.");
    }
    const message: Message = { role, content: content as string | null };
    if (Array.isArray(entry.tool_calls)) {
      message.tool_calls = entry.tool_calls as Message["tool_calls"];
    }
    if (typeof entry.tool_call_id === "string") {
      message.tool_call_id = entry.tool_call_id;
    }
    messages.push(message);
  }
  return messages;
}

/** Write the history to `file`, creating the sessions directory as needed. */
export function saveSession(file: string, messages: readonly Message[], cwd: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeSession(messages, cwd), "utf8");
}

/** Load and parse a session file. */
export function loadSession(file: string): Message[] {
  if (!existsSync(file)) {
    throw new Error(`Session file not found: ${file}`);
  }
  return parseSession(readFileSync(file, "utf8"));
}

export interface SessionInfo {
  path: string;
  name: string;
  modified: Date;
  sizeBytes: number;
}

/** All saved sessions, most recently modified first. */
export function listSessions(dir: string = sessionsDir()): SessionInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = statSync(full);
      return { path: full, name, modified: stat.mtime, sizeBytes: stat.size };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Path of the most recent session file, if any. */
export function latestSessionPath(dir: string = sessionsDir()): string | undefined {
  return listSessions(dir)[0]?.path;
}
