# Personal Coding Agent — Blueprint

Owner: Hao (GitHub: Tomhao10225101490) · Stack: TypeScript / Node.js · License: MIT
Status: v0.4.0 built 2026-11-02 (see "Shipped" below). Name: `hao-code`.

## What it is

A terminal coding agent in the style of Codex / Claude Code: you run it in any
project folder, chat with it, and it reads/edits files and runs commands for you,
asking permission before anything destructive.

## Architecture (as built)

```
src/
  cli.ts          Entry point: flags (--yes/--trace/--no-fx/--continue/--resume), REPL, slash commands
  agent.ts        The agent loop: model -> tool calls -> results -> repeat
  provider.ts     Provider interface + Message/ToolCall/ToolDef/TokenUsage types
  providers/
    openai-compatible.ts  OpenAI-compatible adapter (Ollama local-first default)
    anthropic.ts          Anthropic Messages API adapter (+ format conversion)
    index.ts              Factory built from resolved settings
  tools/
    read.ts       read_file (with line ranges)
    write.ts      write_file (create/overwrite, diff preview first)
    edit.ts       edit_file (exact-match replacement)
    shell.ts      run_command (timeout, output capture, approval gate)
    search.ts     grep / glob over the working tree
    git.ts        git_status / git_diff / git_log / git_commit (approval)
  permissions.ts  Approval prompts + session allowlist; unified-diff previews
  diff.ts         LCS-based unified diff used by the permission previews
  sessions.ts     Session save/resume (~/.hao-code/sessions/<timestamp>.json)
  ui.ts           Presentation: trace formatting, ANSI colors, banner,
                  spinner, progressive diff reveal (zero dependencies)
  server.ts       App server: localhost-only HTTP + SSE API over the agent
                  core (config/sessions endpoints, turn streaming, approval
                  bridge for the PermissionGate)
ui/               Desktop-style app UI: vanilla HTML/CSS/JS, no build step,
                  served by server.ts (sidebar, conversation, diff pane)
  config.ts       ~/.config/hao-code/config.json loading + precedence resolution
  context.ts      System prompt, AGENTS.md loading
```

Data flow: user message -> agent loop -> provider streams a reply; when the
model requests tool calls, the permission layer approves/denies each one, tools
execute, results go back to the model; loop ends when the model replies with no
tool calls. The history is persisted to the session file after every turn.

## v0.1 scope — all shipped

- [x] CLI REPL with streaming responses (`npm i -g` installable, `npx` runnable)
- [x] Agent loop with the core tools (read/write/edit/shell/search/list)
- [x] Approval flow: summaries shown before writes; commands confirmed before running
- [x] Reads `AGENTS.md` / `.agent.md` from the project root as standing instructions
- [x] Works in any directory; respects `.gitignore` in search
- [x] Config via env vars (`*_API_KEY`, model name)
- [x] README, MIT LICENSE (demo GIF not done)

## Shipped in 0.2.0 (2026-11-02)

Formerly "v0.2 candidates", now built and tested:

- [x] Second provider: Anthropic (native Messages API, streaming, tool calls) —
  provider selection via `AGENT_PROVIDER`, config file, or `ANTHROPIC_API_KEY`
  auto-detection. The OpenAI-compatible adapter still covers local models (Ollama).
- [x] Git tools (status/diff/log/commit with approval)
- [x] Session save/resume (`--continue`, `--resume <file>`, `/sessions`)
- [x] Config file `~/.config/hao-code/config.json` (env > config > defaults)
- [x] Unified diffs (LCS) in permission prompts for write/edit
- [x] Token/cost display: step + token-usage summary line after each turn
  (when the provider reports usage)
- [x] REPL slash commands: /help, /tools, /model, /sessions, /clear, /exit

## Shipped in 0.3.0 (2026-11-02) — show your work, hacker-style

Goal: make the agent's reasoning and edits visible as they happen, in the
spirit of Claude Code's readable activity feed.

- [x] **Trace mode** — `--trace` flag, `/trace` REPL toggle, `AGENT_TRACE`
  env var, or `"trace": true` in the config file. After each step the CLI
  renders a structured feed: step number and elapsed time, each tool call
  with pretty-printed JSON arguments, and a preview of each result (first
  12 lines). The system prompt also asks the model to narrate briefly
  before each tool call, so the feed reads like a chain of thought. Pure
  formatters live in `src/ui.ts` and are unit-tested.
- [x] **Terminal effects** (`src/ui.ts`, zero dependencies) — hand-rolled
  ANSI colors (cyan paths, green/red diff lines, magenta `@@` hunks, dim
  meta text), an ASCII banner, a braille spinner while waiting on the
  model (interval is unref'd, so it never keeps the process alive), and a
  progressive diff reveal: approved write/edit diffs print line by line
  (~6 ms/line, total capped at ~1.2 s; huge diffs print instantly). On by
  default on a TTY; `--no-fx` disables, `--fx` / `FORCE_FX=1` forces on;
  fully off when piped so logs and tests stay plain.
- [x] **End-of-turn panel** — steps, tool calls, files changed (tracked
  from successful write/edit results), and token usage when the provider
  reports it. Shown when trace or effects are on; otherwise the plain
  one-line usage summary from 0.2.0 is unchanged.
- [x] The agent loop now awaits step/tool/turn events (streamed tokens
  excepted), so the CLI can finish a diff reveal before the next step.
- [x] 51 tests passing (21 new: ui formatters, painter/colorizing, diff
  reveal equivalence, spinner, fx resolution, trace config).

## Shipped in 0.4.0 (2026-11-02) — desktop-style app UI

Goal (Hao): hao-code must also look and work like a coding-agent desktop
app (Cursor / Claude Code desktop style), while the CLI stays for CLI
users. Route: a local web UI served by hao-code itself over the same
agent core — native packaging (Electron/Tauri) is the follow-on step.

- [x] **App server** (`src/server.ts`) — `node:http` on 127.0.0.1 only,
  default port 7770 (`--port` flag / `HAO_CODE_PORT`). Serves the static
  UI from `ui/`; API: `GET /api/config` (API key masked), `GET
  /api/sessions`, `POST /api/turn` as SSE (every agent event, plus
  `permission_request`, ending with `done`/`error`; one turn at a time,
  concurrent turns get 409), `POST /api/approve` (`y`/`n`/`a`).
- [x] **Permission bridging** — the gate's ask callback emits a
  `permission_request` event (id, tool, headline summary, `diffPreviewFor`
  diff for write/edit) and awaits `/api/approve`; unanswered approvals
  deny on timeout (120 s), and a browser disconnect fails closed.
- [x] **The UI** (`ui/index.html` / `styles.css` / `app.js`, vanilla, no
  build step, no external assets) — dark desktop layout: sidebar (name,
  version, session list, provider/model badge, trace toggle), streaming
  conversation with tool-call cards and trace step headers, approval
  cards with Approve/Deny/Always buttons, end-of-turn panel, and a
  right-hand pane collecting each turn's diffs with green/red lines.
- [x] **CLI wiring** — `hao-code app [--port N] [--open]`; `--open`
  launches the default browser via the OS opener. REPL and one-shot
  modes untouched.
- [x] 56 tests passing (5 new in `test/server.test.ts`: static UI +
  config/session APIs with key masking, an approved SSE turn that
  writes the file — including a 409 check mid-turn — a denied turn that
  writes nothing, and unknown-id approvals).

## Future candidates

- Native desktop packaging of the app UI (Electron/Tauri)
- History summarization for very long tasks
- MCP client support
- Subagent delegation

## Design principles

1. Provider-agnostic core: the loop never imports a vendor SDK directly.
2. Safe by default: no silent writes, no silent shell. Everything destructive is shown first.
3. Boring, readable code over clever code — this is a public repo people will fork.
4. Tests for the loop and tools from day one (`node:test`; vitest was dropped
   in favor of the built-in runner to keep dev dependencies minimal).

## Open decisions

- ~~Project name (npm package + binary name).~~ **Decided 2026-11-02: `hao-code`** (placeholder, easily renamed).
- ~~First provider: OpenAI / Anthropic / OpenAI-compatible.~~ **Decided 2026-11-02: OpenAI-compatible adapter, local-first via Ollama** — default base URL `http://localhost:11434/v1`, no API key required; default model `qwen2.5-coder:7b`; overrides via `AGENT_BASE_URL` / `AGENT_API_KEY` / `AGENT_MODEL`. (Hao has no API key yet, hence local-first.) Anthropic added alongside it in 0.2.0.
- Build location: develop on Hao's Mac, publish to github.com/Tomhao10225101490.
