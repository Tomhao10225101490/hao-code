#!/usr/bin/env node
// hao-code CLI: a small REPL around the agent loop.
//
// Usage:
//   hao-code                 start an interactive session in the current folder
//   hao-code "fix the tests" run one instruction and exit
//   hao-code --continue      resume the most recent saved session
//   hao-code --resume <file> resume a specific saved session
//   hao-code --yes ...       auto-approve all tool actions (careful!)
//   hao-code --trace         show the step-by-step trace feed (see ui.ts)
//   hao-code --no-fx         plain output: no colors/banner/spinner
//   hao-code app [--port N] [--open]
//                            serve the desktop-style app UI on 127.0.0.1
//
// Configuration precedence: CLI flags > environment variables (or .env) >
// ~/.config/hao-code/config.json > built-in defaults (local Ollama).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./agent.js";
import { loadConfigFile, resolveSettings, type ResolvedSettings } from "./config.js";
import { diffPreviewFor, PermissionGate } from "./permissions.js";
import { createProvider, type AnyProvider } from "./providers/index.js";
import { startAppServer } from "./server.js";
import {
  Spinner,
  banner,
  colorizeDiff,
  createPainter,
  formatStepHeader,
  formatToolArgs,
  formatTurnPanel,
  resolveFx,
  revealDiff,
  truncatePreview,
  type TurnStats,
} from "./ui.js";
import {
  latestSessionPath,
  listSessions,
  loadSession,
  newSessionPath,
  sessionsDir,
} from "./sessions.js";
import { toolRegistry } from "./tools/index.js";

function version(): string {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.4.0";
  } catch {
    return "0.4.0";
  }
}

/** Minimal .env loader (no dependencies): KEY=VALUE lines, never overrides real env. */
function loadDotEnv(cwd: string): void {
  const file = path.join(cwd, ".env");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function printHelp(settings?: ResolvedSettings): void {
  console.log(
    [
      "hao-code — a personal coding agent for your terminal",
      "",
      "Usage:",
      "  hao-code                  interactive session in the current directory",
      '  hao-code "your request"   run a single instruction, then exit',
      "  hao-code app [options]    desktop-style app UI in your browser (local only)",
      "                            --port N  port to bind (default 7770, or $HAO_CODE_PORT)",
      "                            --open    open the UI in your default browser",
      "",
      "Flags:",
      "  --yes, -y          auto-approve all file writes and commands (dangerous)",
      "  --trace            show the trace feed: per-step tool args and result previews",
      "  --no-fx            disable colors, banner, spinner, and diff animations",
      "  --fx               force visual effects on (even when output is piped)",
      "  --continue         resume the most recent saved session",
      "  --resume <file>    resume a specific session file from ~/.hao-code/sessions/",
      "  --help, -h         show this help",
      "",
      "In-session commands:",
      "  /help        show this help",
      "  /tools       list the tools the agent can use",
      "  /model       show the current provider and model",
      "  /trace       toggle the step-by-step trace feed",
      "  /sessions    list saved sessions (current one marked with *)",
      "  /clear       forget the conversation and start fresh",
      "  /exit        quit (also /quit or Ctrl+C)",
      "",
      "Configuration (highest precedence first): CLI flags, environment",
      "variables / .env file, then ~/.config/hao-code/config.json:",
      '  { "provider": "openai-compatible" | "anthropic", "baseUrl": "...",',
      '    "apiKey": "...", "model": "...", "autoApprove": false, "trace": false }',
      "Environment variables:",
      "  AGENT_PROVIDER   openai-compatible | anthropic (default: auto-detect)",
      "  AGENT_BASE_URL   endpoint base URL (default http://localhost:11434/v1)",
      "  AGENT_MODEL      model name (default qwen2.5-coder:7b / claude-sonnet-4-5)",
      "  AGENT_API_KEY    API key / bearer token for either provider",
      "  AGENT_TRACE      1 or true enables trace mode (or \"trace\": true in config)",
      "  ANTHROPIC_API_KEY  Anthropic key (its presence selects the Anthropic provider)",
      settings
        ? `\nCurrently: provider=${settings.provider}, model=${settings.model}, base=${settings.baseUrl}, trace=${settings.trace ? "on" : "off"}`
        : "",
    ].join("\n"),
  );
}

function printTools(): void {
  console.log("Tools available to the agent:");
  for (const tool of Object.values(toolRegistry)) {
    const firstSentence = tool.def.function.description.split(". ")[0];
    console.log(
      `  ${tool.def.function.name.padEnd(12)} ${firstSentence}${tool.requiresApproval ? "  [asks permission]" : ""}`,
    );
  }
}

function printSessions(currentFile: string | undefined): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(`No saved sessions yet (they live in ${sessionsDir()}).`);
    return;
  }
  console.log(`Saved sessions in ${sessionsDir()}:`);
  for (const s of sessions) {
    const mark = currentFile && path.resolve(s.path) === path.resolve(currentFile) ? "*" : " ";
    const kb = Math.max(1, Math.round(s.sizeBytes / 1024));
    console.log(
      ` ${mark} ${s.name}  (${s.modified.toLocaleString()}, ${kb} KB)`,
    );
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return truncate(JSON.stringify(args), 90);
}

function formatCount(n: number | undefined): string {
  return n === undefined ? "?" : n.toLocaleString("en-US");
}

interface CliArgs {
  autoYes: boolean;
  help: boolean;
  trace: boolean;
  fx: boolean;
  noFx: boolean;
  resumeFile?: string;
  continueLast: boolean;
  oneShot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    autoYes: false,
    help: false,
    trace: false,
    fx: false,
    noFx: false,
    continueLast: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") out.autoYes = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--trace") out.trace = true;
    else if (arg === "--fx") out.fx = true;
    else if (arg === "--no-fx") out.noFx = true;
    else if (arg === "--continue") out.continueLast = true;
    else if (arg === "--resume") {
      const value = argv[++i];
      if (!value) throw new Error("--resume needs a session file path");
      out.resumeFile = value;
    } else if (arg.startsWith("--resume=")) {
      out.resumeFile = arg.slice("--resume=".length);
    } else if (arg.startsWith("-")) {
      console.error(`Warning: ignoring unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) out.oneShot = positional.join(" ");
  return out;
}

/** Open a URL in the OS default browser, fire-and-forget. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best effort only — the URL is printed either way.
  }
}

/**
 * `hao-code app [--port N] [--open]`: serve the desktop-style web UI.
 * The server binds 127.0.0.1 only and drives the same agent core as the
 * CLI; permission prompts appear as approval cards in the browser.
 */
async function runAppCommand(argv: string[], cwd: string): Promise<void> {
  let port: number | undefined;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--open") {
      open = true;
    } else if (arg === "--port") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--port needs a port number");
      port = Number(value);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: hao-code app [--port N] [--open]",
          "",
          "Serve the desktop-style app UI on http://127.0.0.1:<port> (localhost",
          "only). The UI drives the same agent as the CLI; writes and commands",
          "ask for approval as cards in the browser unless auto-approve is on.",
          "",
          "  --port N   port to bind (default: $HAO_CODE_PORT or 7770)",
          "  --open     open the UI in your default browser",
        ].join("\n"),
      );
      return;
    } else {
      console.error(`Warning: ignoring unknown app flag ${arg}`);
    }
  }
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error(`invalid port: ${String(port)}`);
  }

  const loaded = loadConfigFile();
  if (loaded.error) {
    console.error(`Warning: ignoring config file — ${loaded.error}`);
  }
  const settings = resolveSettings(process.env, loaded.config);

  const running = await startAppServer({
    settings,
    cwd,
    port,
    version: version(),
  });
  console.log(`hao-code app → ${running.url}`);
  console.log(
    `provider: ${settings.provider} · model: ${settings.model} @ ${settings.baseUrl}`,
  );
  console.log(`working directory: ${cwd}`);
  console.log(
    settings.autoApprove
      ? "permissions: AUTO-APPROVED by your settings. Be careful."
      : "permissions: writes and commands will ask as cards in the browser.",
  );
  console.log("Local only (127.0.0.1). Press Ctrl+C to stop.");
  if (open) openBrowser(running.url);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      console.log("\nStopping…");
      void running.close().then(resolve, resolve);
    });
  });
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  loadDotEnv(cwd);

  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "app") {
    try {
      await runAppCommand(rawArgv.slice(1), cwd);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  let args: CliArgs;
  try {
    args = parseArgs(rawArgv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const loaded = loadConfigFile();
  if (loaded.error) {
    console.error(`Warning: ignoring config file — ${loaded.error}`);
  }
  const settings = resolveSettings(process.env, loaded.config);

  if (args.help) {
    printHelp(settings);
    return;
  }

  const provider: AnyProvider = createProvider(settings);
  const autoApprove = args.autoYes || settings.autoApprove;

  // Presentation: trace feed (--trace flag wins over AGENT_TRACE / config)
  // and visual effects (on for terminals, --no-fx off, --fx / FORCE_FX on).
  let traceOn = args.trace || settings.trace;
  const fxOn = resolveFx({
    fxFlag: args.fx,
    noFxFlag: args.noFx,
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
  const painter = createPainter(fxOn);
  const spinner = new Spinner({ enabled: fxOn, painter });

  // Decide which session file this run reads/writes.
  let sessionFile: string;
  let resumeFrom: string | undefined;
  if (args.resumeFile) {
    resumeFrom = path.resolve(cwd, args.resumeFile);
    sessionFile = resumeFrom;
  } else if (args.continueLast) {
    const latest = latestSessionPath();
    if (latest) {
      resumeFrom = latest;
      sessionFile = latest;
    } else {
      console.log("No saved session to continue — starting a new one.");
      sessionFile = newSessionPath();
    }
  } else {
    sessionFile = newSessionPath();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you › ",
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const gate = new PermissionGate({
    autoApprove,
    ask,
    // With effects on, the diff inside approval prompts is colorized.
    log: fxOn ? (text) => console.log(colorizeDiff(text, painter)) : undefined,
  });

  let streamedText = false;

  // --- Per-turn presentation state: trace feed buffer + turn statistics ---
  interface TraceCall {
    name: string;
    args: Record<string, unknown>;
    ok?: boolean;
    result?: string;
  }
  let traceStep:
    | { step: number; startedAt: number; calls: TraceCall[] }
    | undefined;
  let pendingDiff: string | undefined;
  let lastCall: { name: string; args: Record<string, unknown> } | undefined;
  let turnToolCalls = 0;
  const turnFiles: string[] = [];

  const indentBlock = (text: string, pad: string): string =>
    text
      .split("\n")
      .map((l) => pad + l)
      .join("\n");

  /** Print the buffered trace feed for the step that just finished. */
  const flushTraceStep = (): void => {
    if (!traceOn || !traceStep) return;
    if (streamedText) process.stdout.write("\n");
    const elapsed = Date.now() - traceStep.startedAt;
    const out: string[] = [formatStepHeader(traceStep.step, elapsed, painter)];
    if (traceStep.calls.length === 0) {
      out.push(painter.dim("  (no tool calls — the model replied with text)"));
    }
    for (const call of traceStep.calls) {
      out.push(`  ${painter.bold("▸")} ${call.name}`);
      out.push(indentBlock(formatToolArgs(call.args), "    "));
      if (call.result !== undefined) {
        out.push(`    ${call.ok ? "✓" : "✗"} result:`);
        out.push(indentBlock(truncatePreview(call.result), "    "));
      }
    }
    console.log(out.join("\n"));
    traceStep = undefined;
  };

  const handleEvent = async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "token":
        spinner.stop();
        streamedText = true;
        process.stdout.write(event.text);
        break;
      case "step":
        flushTraceStep();
        traceStep = { step: event.step, startedAt: Date.now(), calls: [] };
        if (event.step > 1) spinner.start("working");
        break;
      case "tool_call":
        spinner.stop();
        turnToolCalls++;
        lastCall = { name: event.name, args: event.args };
        // Computed now, while the file still holds its pre-edit content.
        pendingDiff = diffPreviewFor(event.name, event.args, cwd);
        if (traceOn) {
          traceStep?.calls.push({ name: event.name, args: event.args });
        } else {
          if (streamedText) process.stdout.write("\n");
          streamedText = false;
          process.stdout.write(
            `  → ${event.name}(${summarizeArgs(event.args)})\n`,
          );
        }
        break;
      case "tool_result": {
        const isFileChange =
          event.name === "write_file" || event.name === "edit_file";
        if (fxOn && event.ok && isFileChange && pendingDiff) {
          // The edit is on disk: replay its diff as a live "typing" reveal.
          if (streamedText) process.stdout.write("\n");
          await revealDiff(pendingDiff, {
            fx: true,
            painter,
            write: (s) => {
              process.stdout.write(s);
            },
          });
        }
        pendingDiff = undefined;
        if (event.ok && isFileChange) {
          const p = lastCall?.args.path;
          if (typeof p === "string" && !turnFiles.includes(p)) {
            turnFiles.push(p);
          }
        }
        if (traceOn) {
          const call = traceStep
            ? [...traceStep.calls]
                .reverse()
                .find((c) => c.result === undefined)
            : undefined;
          if (call) {
            call.ok = event.ok;
            call.result = event.result;
          }
        } else {
          const firstLine = event.result.split("\n")[0] ?? "";
          process.stdout.write(
            `  ${event.ok ? "✓" : "✗"} ${event.name}: ${truncate(firstLine, 110)}\n`,
          );
        }
        break;
      }
      case "max_steps":
        spinner.stop();
        process.stdout.write(
          `\n[stopped: reached the ${event.steps}-step limit for one turn]\n`,
        );
        break;
      case "turn_end": {
        spinner.stop();
        flushTraceStep();
        if (fxOn || traceOn) {
          if (streamedText) process.stdout.write("\n");
          const stats: TurnStats = {
            steps: event.steps,
            toolCalls: turnToolCalls,
            filesChanged: [...turnFiles],
            usage: event.usage,
          };
          console.log(formatTurnPanel(stats, painter));
          // Note: streamedText stays true when the turn's text was streamed,
          // so runOne does not print the final text a second time.
        } else if (event.usage) {
          if (streamedText) process.stdout.write("\n");
          process.stdout.write(
            `[turn: ${event.steps} step${event.steps === 1 ? "" : "s"} · tokens: ` +
              `${formatCount(event.usage.inputTokens)} in / ${formatCount(event.usage.outputTokens)} out]\n`,
          );
        }
        break;
      }
    }
  };

  const agent = new Agent(provider, gate, cwd, handleEvent);
  agent.setSessionFile(sessionFile);

  let resumedCount = 0;
  if (resumeFrom) {
    try {
      const history = loadSession(resumeFrom);
      agent.loadHistory(history);
      resumedCount = history.length;
    } catch (err) {
      console.error(
        `Error: could not resume session: ${err instanceof Error ? err.message : String(err)}`,
      );
      rl.close();
      process.exit(1);
    }
  }

  if (fxOn) {
    console.log(banner(version(), painter));
    console.log(
      [
        `provider: ${provider.name} · model: ${provider.model} @ ${provider.baseURL}`,
        `working directory: ${painter.cyan(cwd)}`,
        resumeFrom
          ? `session: resumed ${resumeFrom} (${resumedCount} messages)`
          : `session: ${sessionFile} (saved after each turn)`,
        autoApprove
          ? "permissions: AUTO-APPROVED. Be careful."
          : "permissions: writes and commands will ask first. /help for commands, /exit to quit.",
        traceOn
          ? "trace: on — a step-by-step feed follows each step (/trace to toggle)"
          : "trace: off (/trace to see the step-by-step feed)",
        "",
      ].join("\n"),
    );
  } else {
    console.log(
      [
        `hao-code v${version()} — your personal coding agent`,
        `provider: ${provider.name} · model: ${provider.model} @ ${provider.baseURL}`,
        `working directory: ${cwd}`,
        resumeFrom
          ? `session: resumed ${resumeFrom} (${resumedCount} messages)`
          : `session: ${sessionFile} (saved after each turn)`,
        autoApprove
          ? "permissions: AUTO-APPROVED. Be careful."
          : "permissions: writes and commands will ask first. /help for commands, /exit to quit.",
        "",
      ].join("\n"),
    );
  }

  const runOne = async (text: string): Promise<void> => {
    streamedText = false;
    turnToolCalls = 0;
    turnFiles.length = 0;
    traceStep = undefined;
    pendingDiff = undefined;
    spinner.start("thinking");
    try {
      const finalText = await agent.runTurn(text);
      if (!streamedText && finalText) console.log(finalText);
      process.stdout.write("\n");
    } finally {
      spinner.stop();
    }
  };

  if (args.oneShot !== undefined) {
    try {
      await runOne(args.oneShot);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
    return;
  }

  let busy = false;
  let ctrlCArmed = false;
  let ctrlCTimer: NodeJS.Timeout | undefined;

  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    if (busy) {
      console.log("(still working on the previous request — please wait)");
      rl.prompt();
      return;
    }
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "/exit" || input === "/quit") {
      rl.close();
      return;
    }
    if (input === "/clear") {
      agent.reset();
      console.log("Conversation cleared.");
      rl.prompt();
      return;
    }
    if (input === "/help") {
      printHelp(settings);
      rl.prompt();
      return;
    }
    if (input === "/tools") {
      printTools();
      rl.prompt();
      return;
    }
    if (input === "/model") {
      console.log(
        `provider: ${provider.name}\nmodel: ${provider.model}\nendpoint: ${provider.baseURL}`,
      );
      rl.prompt();
      return;
    }
    if (input === "/trace") {
      traceOn = !traceOn;
      console.log(
        traceOn
          ? "Trace mode on — a step-by-step feed will follow each step."
          : "Trace mode off.",
      );
      rl.prompt();
      return;
    }
    if (input === "/sessions") {
      printSessions(agent.getSessionFile());
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      console.log(`Unknown command: ${input} — /help lists the commands.`);
      rl.prompt();
      return;
    }
    busy = true;
    void (async () => {
      try {
        await runOne(input);
      } catch (err) {
        console.error(
          `\nError: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        busy = false;
        rl.prompt();
      }
    })();
  });

  rl.on("SIGINT", () => {
    if (busy && !ctrlCArmed) {
      ctrlCArmed = true;
      console.log("\nAgent is working — press Ctrl+C again to quit anyway.");
      ctrlCTimer = setTimeout(() => {
        ctrlCArmed = false;
      }, 3000);
      return;
    }
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    rl.close();
  });

  rl.on("close", () => {
    console.log("Bye.");
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
