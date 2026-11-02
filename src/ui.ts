// Terminal presentation: colors, trace formatting, spinner, banners, and the
// progressive diff reveal.
//
// Everything here is hand-rolled (zero dependencies) and split into two kinds
// of code: pure formatting helpers (formatStepHeader, formatToolArgs,
// truncatePreview, formatTurnPanel, banner — all unit-tested) and thin output
// effects (Spinner, revealDiff) that take an injectable `write` so tests can
// capture what would have been printed.

import type { TokenUsage } from "./provider.js";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface Painter {
  readonly enabled: boolean;
  cyan(text: string): string;
  green(text: string): string;
  red(text: string): string;
  magenta(text: string): string;
  yellow(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const RESET = "\x1b[0m";

function wrap(code: string): (text: string) => string {
  return (text) => `\x1b[${code}m${text}${RESET}`;
}

function identity(text: string): string {
  return text;
}

/** A painter that adds ANSI colors when enabled, and is a no-op otherwise. */
export function createPainter(enabled: boolean): Painter {
  if (!enabled) {
    return {
      enabled,
      cyan: identity,
      green: identity,
      red: identity,
      magenta: identity,
      yellow: identity,
      dim: identity,
      bold: identity,
    };
  }
  return {
    enabled,
    cyan: wrap("36"),
    green: wrap("32"),
    red: wrap("31"),
    magenta: wrap("35"),
    yellow: wrap("33"),
    dim: wrap("2"),
    bold: wrap("1"),
  };
}

/** Shared no-color painter, used as the default everywhere. */
export const noPaint: Painter = createPainter(false);

/**
 * Color one diff line: additions green, removals red, hunk headers magenta,
 * file headers bold. Leading indentation (as used in permission prompts) is
 * preserved; context and other lines pass through unchanged.
 */
export function colorizeDiffLine(line: string, painter: Painter): string {
  if (!painter.enabled) return line;
  const indentLen = line.length - line.trimStart().length;
  const indent = line.slice(0, indentLen);
  const body = line.slice(indentLen);
  if (body.startsWith("@@")) return indent + painter.magenta(body);
  if (body.startsWith("+++") || body.startsWith("---")) {
    return indent + painter.bold(body);
  }
  if (body.startsWith("+")) return indent + painter.green(body);
  if (body.startsWith("-")) return indent + painter.red(body);
  return line;
}

/** Color every line of a unified diff (or a block containing one). */
export function colorizeDiff(diff: string, painter: Painter): string {
  if (!painter.enabled) return diff;
  return diff
    .split("\n")
    .map((line) => colorizeDiffLine(line, painter))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Trace-mode formatting (pure)
// ---------------------------------------------------------------------------

/** "250ms", "1.2s", "12s", "1m 05s" — compact elapsed-time formatting. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** Header line for one step of the trace feed: "── step 3 · 1.2s ──". */
export function formatStepHeader(
  step: number,
  elapsedMs: number,
  painter: Painter = noPaint,
): string {
  return (
    painter.dim("── ") +
    painter.bold(`step ${step}`) +
    painter.dim(` · ${formatElapsed(elapsedMs)} ──`)
  );
}

/**
 * Pretty-print tool call arguments as indented JSON, capped so a huge
 * write_file payload cannot flood the trace feed.
 */
export function formatToolArgs(
  args: Record<string, unknown>,
  maxChars = 800,
): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    text = String(args);
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n… (args truncated)";
  }
  return text;
}

/**
 * The first `maxLines` lines of a tool result, plus a "… (N more lines)"
 * marker when the result was longer. A single trailing newline is treated
 * as a line terminator, not an extra empty line.
 */
export function truncatePreview(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return lines.join("\n");
  const hidden = lines.length - maxLines;
  return [
    ...lines.slice(0, maxLines),
    `… (${hidden} more line${hidden === 1 ? "" : "s"})`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Banner and end-of-turn panel (pure)
// ---------------------------------------------------------------------------

/** Small ASCII-art banner shown when the REPL starts with effects on. */
export function banner(version: string, painter: Painter = noPaint): string {
  const art = [
    "╦ ╦╔═╗╔═╗  ╔═╗╔═╗╔╦╗╔═╗",
    "╠═╣╠═╣║ ║  ║  ║ ║ ║║║╣ ",
    "╩ ╩╩ ╩╚═╝  ╚═╝╚═╝═╩╝╚═╝",
  ];
  return [
    ...art.map((line) => painter.cyan(line)),
    `${painter.bold("hao-code")} v${version} — your personal coding agent`,
  ].join("\n");
}

export interface TurnStats {
  steps: number;
  toolCalls: number;
  /** Paths of files created/edited during the turn (deduplicated). */
  filesChanged: string[];
  usage?: TokenUsage;
}

function formatCount(n: number | undefined): string {
  return n === undefined ? "?" : n.toLocaleString("en-US");
}

/** Compact summary panel printed when a turn finishes (effects on). */
export function formatTurnPanel(
  stats: TurnStats,
  painter: Painter = noPaint,
): string {
  const files =
    stats.filesChanged.length > 0
      ? stats.filesChanged.map((f) => painter.cyan(f)).join(", ")
      : "none";
  const lines = [
    painter.dim("╭─ ") + painter.bold("turn complete") + painter.dim(" ─────────────"),
    `│ steps: ${stats.steps} · tool calls: ${stats.toolCalls} · files changed: ${files}`,
  ];
  if (stats.usage) {
    lines.push(
      `│ tokens: ${formatCount(stats.usage.inputTokens)} in / ${formatCount(stats.usage.outputTokens)} out`,
    );
  }
  lines.push(painter.dim("╰────────────────────────────────"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Effects: spinner and progressive diff reveal
// ---------------------------------------------------------------------------

export interface FxOptions {
  fxFlag?: boolean;
  noFxFlag?: boolean;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide whether visual effects are on. --no-fx always wins; --fx and the
 * FORCE_FX=1 test override force them on; otherwise they follow the TTY.
 */
export function resolveFx(opts: FxOptions): boolean {
  if (opts.noFxFlag) return false;
  if (opts.fxFlag) return true;
  if (opts.env?.FORCE_FX === "1") return true;
  return Boolean(opts.isTTY);
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerOptions {
  enabled?: boolean;
  write?: (text: string) => void;
  painter?: Painter;
  intervalMs?: number;
}

/**
 * A braille spinner drawn on the current line while waiting for the model.
 * The interval is unref'd, so a forgotten spinner can never keep the
 * process alive. When disabled, start/stop are silent no-ops.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private label = "working";
  private readonly enabled: boolean;
  private readonly write: (text: string) => void;
  private readonly painter: Painter;
  private readonly intervalMs: number;

  constructor(opts: SpinnerOptions = {}) {
    this.enabled = opts.enabled ?? false;
    this.write = opts.write ?? ((t) => void process.stdout.write(t));
    this.painter = opts.painter ?? noPaint;
    this.intervalMs = opts.intervalMs ?? 80;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(label = "working"): void {
    if (!this.enabled || this.timer !== undefined) return;
    this.label = label;
    this.render();
    this.timer = setInterval(() => this.render(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.write("\r\x1b[2K"); // carriage return + erase the spinner line
  }

  private render(): void {
    const frame = BRAILLE_FRAMES[this.frame % BRAILLE_FRAMES.length];
    this.frame++;
    this.write(`\r${this.painter.cyan(frame)} ${this.painter.dim(this.label)}`);
  }
}

export interface RevealDiffOptions {
  /** When false, the diff is written in one go — a passthrough reveal. */
  fx: boolean;
  painter?: Painter;
  write?: (text: string) => void;
  /** Injectable for tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Target delay per line when effects are on. Default 6ms. */
  perLineMs?: number;
  /** Total reveal budget; the per-line delay shrinks to fit. Default 1200ms. */
  maxTotalMs?: number;
  /** Diffs longer than this many lines are printed instantly. Default 400. */
  instantLineThreshold?: number;
}

/**
 * Print a unified diff, "typing it out" line by line when effects are on.
 * Always resolves with the final rendered string (colorized when the
 * painter is enabled), which is identical whether fx is on or off — fx
 * only changes the pacing, never the content.
 */
export async function revealDiff(
  diff: string,
  opts: RevealDiffOptions,
): Promise<string> {
  const painter = opts.painter ?? noPaint;
  const rendered = painter.enabled ? colorizeDiff(diff, painter) : diff;
  const write = opts.write;
  if (!write) return rendered;

  const perLineMs = opts.perLineMs ?? 6;
  const maxTotalMs = opts.maxTotalMs ?? 1200;
  const threshold = opts.instantLineThreshold ?? 400;
  const lines = rendered.split("\n");

  if (!opts.fx || perLineMs <= 0 || lines.length > threshold) {
    write(rendered.endsWith("\n") ? rendered : rendered + "\n");
    return rendered;
  }

  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delay = Math.min(perLineMs, maxTotalMs / lines.length);
  for (const line of lines) {
    write(line + "\n");
    if (delay > 0) await sleep(delay);
  }
  return rendered;
}
