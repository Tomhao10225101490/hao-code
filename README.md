# hao-code

A personal, open-source **coding agent for your terminal** — in the spirit of
Codex and Claude Code, but small, readable, and **local-first**: out of the box
it talks to an [Ollama](https://ollama.com) server on your own machine, so it
works with **no API key and no cloud account**. When you want a hosted model,
point it at any OpenAI-compatible endpoint — or flip one setting and use
Anthropic's native Messages API instead.

> **Status: v0.3.** The agent loop, two providers, git tools, session
> save/resume, config file, permission prompts with real unified diffs —
> plus trace mode and a live "hacker-style" terminal presentation — all
> work and are covered by tests. Still a young project: expect rough
> edges, and see the roadmap below.

## What it does

Run `hao-code` inside any project folder and chat with it:

```
you › add a .gitignore for this project and run the tests
```

The agent can read and edit files, search the codebase, run commands, and
inspect or commit git history — asking your permission, with a unified diff
preview, before anything that changes state. After each turn it can show a
one-line summary of steps taken and tokens used.

## Quickstart

Requirements: Node.js >= 18, and (for the default local setup) Ollama.

```bash
# 1. Install Ollama (https://ollama.com/download), then pull a coding model:
ollama pull qwen2.5-coder:7b
# (Ollama normally runs in the background; if not: `ollama serve`)

# 2. Get hao-code and build it:
git clone <this repo> hao-code
cd hao-code
npm install
npm run build

# 3. Run it in any project:
node dist/cli.js            # or: npm start
# …or install the command globally:
npm link                    # then just run: hao-code
```

You can also pass a single instruction and exit:

```bash
hao-code "explain what this project does"
```

### Using a hosted model instead

**Anthropic (native Messages API):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
hao-code            # the key's presence selects the Anthropic provider
# default model: claude-sonnet-4-5 (override with ANTHROPIC_MODEL or AGENT_MODEL)
```

**OpenAI or another OpenAI-compatible host:**

```bash
export AGENT_BASE_URL=https://api.openai.com/v1
export AGENT_MODEL=gpt-4o-mini
export AGENT_API_KEY=sk-...
hao-code
```

LM Studio / llama.cpp work the same way — just point `AGENT_BASE_URL` at
their local servers.

**Choosing a local model:** tool calling needs a model that supports it.
`qwen2.5-coder:7b` is a good default; larger variants (14b/32b) follow
instructions noticeably better if your hardware allows.

## Features

- **Agent loop** — streams replies, executes tool calls, feeds results back,
  capped at 25 steps per turn so a confused model cannot loop forever.
- **Two providers, one interface** — OpenAI-compatible (Ollama, OpenAI,
  LM Studio, llama.cpp, most gateways) and Anthropic's native Messages API,
  both with streaming and streamed tool-call assembly.
- **10 tools** — files (read/write/edit), search, shell, and git
  (status/diff/log/commit), all behind a permission gate.
- **Unified diff previews** — file writes and edits show a real `diff -u`
  style preview (LCS-based, built in) before you approve them.
- **Sessions** — the conversation is saved to
  `~/.hao-code/sessions/<timestamp>.json` after every turn. Resume with
  `--continue` (most recent) or `--resume <file>`; list them with `/sessions`.
- **Config file** — `~/.config/hao-code/config.json` for provider, endpoint,
  model, key, and auto-approve, overridden by env vars and CLI flags.
- **Token usage** — when the backend reports it, each turn ends with a
  step/token summary line. (Older local servers may not report usage.)
- **Trace mode** — with `--trace` (or `/trace` in a session), a structured
  feed follows each step: step number, elapsed time, every tool call with
  pretty-printed JSON arguments, and a preview of each result. The model
  also narrates briefly before each call, so you can watch it reason.
- **Live terminal presentation** — on a real terminal: an ASCII banner, a
  braille spinner while the model thinks, colorized diffs, approved edits
  that type themselves out line by line, and a compact end-of-turn panel
  (steps, tool calls, files changed, tokens). Plain when piped;
  `--no-fx` / `--fx` override.
- **REPL commands** — `/help`, `/tools`, `/model`, `/trace`, `/sessions`,
  `/clear`, `/exit`.

## Configuration

Precedence, highest first: **CLI flags** > **environment variables** (or a
`.env` file in the folder you run `hao-code` from) > **config file**
(`~/.config/hao-code/config.json`) > **built-in defaults**.

Config file example:

```json
{
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-4-5",
  "autoApprove": false,
  "trace": false
}
```

Environment variables (see also `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_PROVIDER` | *(auto)* | `openai-compatible` or `anthropic`. Auto: config file, else Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI-compatible |
| `AGENT_BASE_URL` | `http://localhost:11434/v1` | Endpoint base URL for the selected provider |
| `AGENT_MODEL` | `qwen2.5-coder:7b` / `claude-sonnet-4-5` | Model name (per provider) |
| `AGENT_API_KEY` | `ollama` | API key / bearer token for either provider |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (wins over `AGENT_API_KEY` for Anthropic) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic endpoint override |
| `ANTHROPIC_MODEL` | *(falls back to `AGENT_MODEL`)* | Anthropic model override |
| `AGENT_TRACE` | — | `1` or `true` enables trace mode by default (same as `--trace`) |

CLI flags: `--yes` (auto-approve), `--trace`, `--no-fx`, `--fx`,
`--continue`, `--resume <file>`, `--help`.

## See it think

hao-code is built to show its work. The model is asked to narrate briefly
before each tool call — what it is about to do and why — and two display
layers turn that into a readable live feed.

**Trace mode** (`--trace`, `/trace` in a session, or `AGENT_TRACE=1` /
`"trace": true` in the config file) prints a structured feed after each
step: the step number and how long it took, every tool call with its
arguments pretty-printed, and the first lines of each result:

```text
I'll create the trace demo file first, then confirm what landed.
── step 1 · 36ms ──
  ▸ write_file
    {
      "path": "trace-demo.txt",
      "content": "hello trace\n"
    }
    ✓ result:
    Wrote 12 bytes (2 lines) to trace-demo.txt.
```

**Terminal effects** (automatic when output is a terminal): an ASCII
banner, a braille spinner while the model is thinking, diffs colored
green/red with magenta hunk headers, and — once you approve an edit — the
diff types itself out line by line, so you can watch the change land.
Every turn ends with a compact panel:

```text
╭─ turn complete ─────────────
│ steps: 2 · tool calls: 1 · files changed: trace-demo.txt
│ tokens: 102 in / 26 out
╰────────────────────────────────
```

Effects turn off automatically when output is piped (logs and tests stay
plain). `--no-fx` forces them off; `--fx` — or `FORCE_FX=1` — forces
them on.

## Tools

| Tool | What it does | Needs approval |
| --- | --- | --- |
| `read_file` | Read a file with line numbers (optional line range) | No |
| `search` | Regex search over file contents (ripgrep, grep fallback) | No |
| `list_files` | List files matching a glob (`src/**/*.ts`) | No |
| `git_status` | Branch + staged/unstaged/untracked summary | No |
| `git_diff` | Unified diff of unstaged (or `staged: true`) changes | No |
| `git_log` | Recent commits (hash, date, author, subject) | No |
| `write_file` | Create or fully overwrite a file (diff preview) | **Yes** |
| `edit_file` | Replace one exact, unique snippet in a file (diff preview) | **Yes** |
| `run_command` | Run a shell command (120s default timeout) | **Yes** |
| `git_commit` | Stage all changes (`git add -A`) and commit | **Yes** |

Standing instructions: if the working directory contains an `AGENTS.md`
(or `.agent.md`), its contents are added to the agent's system prompt.

## Architecture

Small and deliberately boring — the whole thing is a few files:

```
src/
  cli.ts          REPL / one-shot entry point, flags, slash commands
  agent.ts        The agent loop (provider -> gate -> tools -> repeat)
  provider.ts     The Provider interface + shared message/tool/usage types
  providers/
    openai-compatible.ts  Streaming chat-completions adapter (Ollama default)
    anthropic.ts          Streaming Messages API adapter + format conversion
    index.ts              Factory: builds the provider chosen by settings
  config.ts       Config file loading + settings resolution (precedence)
  sessions.ts     Session save/load/list (~/.hao-code/sessions/)
  ui.ts           Presentation: trace formatting, ANSI colors, banner,
                  spinner, progressive diff reveal (hand-rolled, no deps)
  diff.ts         LCS-based unified diff for approval previews
  permissions.ts  The approval gate (diffs, summaries, session allowlist)
  context.ts      System prompt builder (loads AGENTS.md)
  tools/          One file per tool + registry (index.ts)
test/             node:test suite — fake provider, local mock servers, tmp repos
```

The agent core never imports a vendor SDK (there are none — zero runtime
dependencies); each provider is a self-contained `fetch` + SSE parser behind
the `Provider` interface, so adding a backend is one new file.

## Safety / permission model

- Read-only tools run automatically. **Writes, edits, shell commands, and
  git commits always prompt first**, showing a summary (a unified diff for
  file changes; the exact command for shell; the message for commits).
- At the prompt you can answer `y` (once), `n` (deny — the model is told and
  will not retry the same action), or `a` (allow this tool for the rest of
  the session).
- `--yes` / `-y` (or `"autoApprove": true` in the config) auto-approves
  everything. Convenient in a sandbox, dangerous anywhere else — off by
  default.
- No telemetry. With the default Ollama setup, nothing leaves your machine.
- Tool output is truncated before it reaches the model, so one huge command
  output cannot flood the context.

## Development

```bash
npm run build   # tsc -> dist/
npm test        # build + node:test suite (fake providers + local servers, no external network)
npm run dev     # tsc --watch
```

Zero runtime dependencies: just `fetch`, `node:readline`, `node:fs`, and
`node:child_process`. Dev dependencies are only `typescript` and `@types/node`.

## Roadmap

- [x] Anthropic provider (native Messages API)
- [x] Git tools (status/diff/log/commit)
- [x] Session save/resume
- [x] Config file (`~/.config/hao-code/config.json`)
- [x] Unified diffs in permission prompts
- [x] Trace mode — visible step-by-step reasoning feed
- [x] Terminal effects — banner, spinner, live diff reveal, turn panel
- [ ] History summarization for very long tasks
- [ ] MCP client support
- [ ] Subagent delegation

## License

MIT © 2026 Hao
