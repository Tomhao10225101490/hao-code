// App server: a desktop-style web UI for hao-code, served locally.
//
// `hao-code app` starts this server. It binds 127.0.0.1 only — the UI is a
// local control surface for the agent running on your own machine, never a
// network service. The server reuses the exact same agent core as the CLI
// (Agent, PermissionGate, providers, sessions); the only difference is how
// events and permission answers travel: agent events stream to the browser
// as Server-Sent Events, and permission prompts become approval cards that
// POST their answer back to /api/approve.
//
// One turn runs at a time (a concurrent POST /api/turn gets a 409), which
// keeps the permission bridging simple: the gate's ask callback always
// belongs to the turn currently streaming.

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentEvent } from "./agent.js";
import type { ResolvedSettings } from "./config.js";
import {
  diffPreviewFor,
  PermissionGate,
  summarizeRequest,
} from "./permissions.js";
import type { Provider } from "./provider.js";
import { createProvider } from "./providers/index.js";
import { listSessions, newSessionPath } from "./sessions.js";

export const DEFAULT_APP_PORT = 7770;

/** How long an approval card may sit unanswered before it counts as "no". */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

const MAX_BODY_BYTES = 1_000_000;

export interface AppServerOptions {
  /** Resolved settings (config file + env), as built by the CLI. */
  settings: ResolvedSettings;
  /** Working directory the server was started in; turns run here by default. */
  cwd: string;
  /** Port to bind. Falls back to $HAO_CODE_PORT, then 7770. 0 = ephemeral. */
  port?: number;
  env?: NodeJS.ProcessEnv;
  /** Inject a provider (tests use the scripted fake). Default: from settings. */
  provider?: Provider;
  /** Directory holding the static UI. Default: the package's ui/ folder. */
  uiDir?: string;
  /** Override the sessions directory (tests keep it hermetic). */
  sessionsDir?: string;
  /** Approval-card timeout in ms. Default 120s; expiry denies the action. */
  approvalTimeoutMs?: number;
  /** Version string shown by /api/config. */
  version?: string;
}

export interface RunningAppServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface PendingApproval {
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

/** Locate the package's ui/ folder from either dist/ or dist/src/ (tests). */
function defaultUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "..", "ui"),
    path.join(here, "..", "..", "ui"),
  ]) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return path.join(here, "..", "ui");
}

/** Mask an API key for display: never return more than a hint of it. */
export function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 4) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-2)}`;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

class AppServer {
  private readonly settings: ResolvedSettings;
  private readonly cwd: string;
  private readonly provider: Provider;
  private readonly uiDir: string;
  private readonly sessionsDir?: string;
  private readonly approvalTimeoutMs: number;
  private readonly version: string;
  private readonly staticCache = new Map<string, string>();

  /** One agent per working directory, created lazily and kept for the chat. */
  private readonly agents = new Map<string, Agent>();
  /** True while a turn is streaming; a second POST /api/turn gets a 409. */
  private busy = false;
  /** The SSE response of the turn in flight, if any. */
  private activeRes: ServerResponse | undefined;
  private activeCwd: string | undefined;
  /** The most recent tool call that has not produced a result yet. */
  private pendingCall: { name: string; args: Record<string, unknown> } | undefined;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private approvalSeq = 0;

  readonly server: Server;

  constructor(opts: AppServerOptions) {
    this.settings = opts.settings;
    this.cwd = path.resolve(opts.cwd);
    this.provider = opts.provider ?? createProvider(opts.settings);
    this.uiDir = opts.uiDir ?? defaultUiDir();
    this.sessionsDir = opts.sessionsDir;
    this.approvalTimeoutMs =
      opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.version = opts.version ?? "dev";
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          res.end();
        }
      });
    });
  }

  // -- routing ------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method ?? "GET"} ${url.pathname}`;

    const staticFile = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
    if (staticFile) return this.serveStatic(staticFile, res);
    if (route === "GET /api/config") return this.handleConfig(res);
    if (route === "GET /api/sessions") return this.handleSessions(res);
    if (route === "POST /api/turn") return this.handleTurn(req, res);
    if (route === "POST /api/approve") return this.handleApprove(req, res);
    return sendJson(res, 404, { error: `no such route: ${route}` });
  }

  private serveStatic(
    entry: { file: string; type: string },
    res: ServerResponse,
  ): void {
    let text = this.staticCache.get(entry.file);
    if (text === undefined) {
      text = readFileSync(path.join(this.uiDir, entry.file), "utf8");
      this.staticCache.set(entry.file, text);
    }
    res.writeHead(200, {
      "Content-Type": entry.type,
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-cache",
    });
    res.end(text);
  }

  private handleConfig(res: ServerResponse): void {
    sendJson(res, 200, {
      app: "hao-code",
      version: this.version,
      provider: this.settings.provider,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl,
      apiKeyMasked: maskApiKey(this.settings.apiKey),
      trace: this.settings.trace,
      autoApprove: this.settings.autoApprove,
      cwd: this.cwd,
    });
  }

  private handleSessions(res: ServerResponse): void {
    const sessions = listSessions(this.sessionsDir).map((s) => ({
      name: s.name,
      path: s.path,
      modified: s.modified.toISOString(),
      sizeBytes: s.sizeBytes,
    }));
    sendJson(res, 200, { sessions });
  }

  // -- turns --------------------------------------------------------------

  private async handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.busy) {
      return sendJson(res, 409, { error: "a turn is already running" });
    }
    let body: { message?: unknown; cwd?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { error: "request body must be JSON" });
    }
    if (typeof body.message !== "string" || body.message.trim() === "") {
      return sendJson(res, 400, { error: "\"message\" must be a non-empty string" });
    }
    let cwd = this.cwd;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") {
        return sendJson(res, 400, { error: "\"cwd\" must be a string" });
      }
      cwd = path.resolve(this.cwd, body.cwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return sendJson(res, 400, { error: `not a directory: ${cwd}` });
      }
    }

    const agent = this.agentFor(cwd);
    this.busy = true;
    this.activeRes = res;
    this.activeCwd = cwd;
    this.pendingCall = undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // If the browser goes away mid-approval, fail closed instead of hanging.
    res.on("close", () => this.denyAllApprovals());

    try {
      const reply = await agent.runTurn(body.message);
      this.send({ type: "done", reply });
    } catch (err) {
      this.send({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.denyAllApprovals();
      this.busy = false;
      this.activeRes = undefined;
      this.activeCwd = undefined;
      this.pendingCall = undefined;
      res.end();
    }
  }

  private async handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { id?: unknown; answer?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      return sendJson(res, 400, { error: "request body must be JSON" });
    }
    const answer = typeof body.answer === "string" ? body.answer.trim().toLowerCase() : "";
    if (answer !== "y" && answer !== "n" && answer !== "a") {
      return sendJson(res, 400, { error: "\"answer\" must be \"y\", \"n\", or \"a\"" });
    }
    if (typeof body.id !== "string") {
      return sendJson(res, 400, { error: "\"id\" must be a string" });
    }
    const pending = this.pendingApprovals.get(body.id);
    if (!pending) {
      return sendJson(res, 404, { error: `no pending approval with id ${body.id}` });
    }
    this.pendingApprovals.delete(body.id);
    clearTimeout(pending.timer);
    pending.resolve(answer);
    return sendJson(res, 200, { ok: true });
  }

  /** Write one SSE event to the turn currently streaming, if there is one. */
  private send(payload: Record<string, unknown>): void {
    if (!this.activeRes || this.activeRes.writableEnded) return;
    this.activeRes.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** Forward an agent event to the browser, enriching tool calls with diffs. */
  private forward(event: AgentEvent, cwd: string): void {
    switch (event.type) {
      case "token":
        this.send({ type: "token", text: event.text });
        break;
      case "step":
        this.send({ type: "step", step: event.step });
        break;
      case "tool_call": {
        this.pendingCall = { name: event.name, args: event.args };
        const diff = diffPreviewFor(event.name, event.args, cwd);
        this.send({
          type: "tool_call",
          name: event.name,
          args: event.args,
          ...(diff ? { diff } : {}),
        });
        break;
      }
      case "tool_result":
        this.pendingCall = undefined;
        this.send({
          type: "tool_result",
          name: event.name,
          ok: event.ok,
          result: event.result,
        });
        break;
      case "max_steps":
        this.send({ type: "max_steps", steps: event.steps });
        break;
      case "turn_end":
        this.send({
          type: "turn_end",
          steps: event.steps,
          ...(event.usage ? { usage: event.usage } : {}),
        });
        break;
    }
  }

  // -- permission bridging --------------------------------------------------

  /**
   * The PermissionGate's ask callback for server turns: turn the prompt into
   * a `permission_request` SSE event and wait for POST /api/approve. The
   * summary and diff come from the same helpers the CLI prompt uses; the
   * tool identity comes from the tool_call event that precedes the ask.
   */
  private askApproval = async (_prompt: string): Promise<string> => {
    if (!this.activeRes) return "n"; // Nobody is watching: fail closed.
    const call = this.pendingCall;
    const cwd = this.activeCwd ?? this.cwd;
    const name = call?.name ?? "unknown";
    const args = call?.args ?? {};
    const diff = call ? diffPreviewFor(name, args, cwd) : undefined;
    const fullSummary = summarizeRequest(name, args, cwd);
    // When a diff is sent separately, the summary is just the headline line
    // (summarizeRequest embeds the diff for write/edit; avoid sending both).
    const summary = diff ? (fullSummary.split("\n")[0] ?? fullSummary) : fullSummary;

    const id = `appr-${++this.approvalSeq}`;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve("n"); // An unanswered card denies on expiry — fail closed.
      }, this.approvalTimeoutMs);
      timer.unref();
      this.pendingApprovals.set(id, { resolve, timer });
      this.send({
        type: "permission_request",
        id,
        tool: name,
        args,
        summary,
        ...(diff ? { diff } : {}),
      });
    });
  };

  private denyAllApprovals(): void {
    for (const [, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve("n");
    }
    this.pendingApprovals.clear();
  }

  private agentFor(cwd: string): Agent {
    const existing = this.agents.get(cwd);
    if (existing) return existing;
    const gate = new PermissionGate({
      autoApprove: this.settings.autoApprove,
      ask: this.askApproval,
      log: () => {},
    });
    const agent = new Agent(this.provider, gate, cwd, (event) =>
      this.forward(event, cwd),
    );
    agent.setSessionFile(newSessionPath(this.sessionsDir));
    this.agents.set(cwd, agent);
    return agent;
  }

  async close(): Promise<void> {
    this.denyAllApprovals();
    const server = this.server;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Start the app server on 127.0.0.1 and resolve once it is listening. */
export async function startAppServer(
  opts: AppServerOptions,
): Promise<RunningAppServer> {
  const env = opts.env ?? process.env;
  const port =
    opts.port ?? parsePort(env.HAO_CODE_PORT) ?? DEFAULT_APP_PORT;
  const app = new AppServer(opts);
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = app.server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  return {
    server: app.server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => app.close(),
  };
}
