# AGENTS.md — working in the hao-code repo

hao-code is a terminal coding agent (TypeScript, Node >= 18, ESM). This file is
also a live example: hao-code itself reads `AGENTS.md` from the working
directory and appends it to its system prompt.

## Commands

- `npm run build` — compile TypeScript to `dist/`
- `npm test` — build, then run the `node:test` suite in `dist/test/`
- `npm run dev` — `tsc --watch`
- `npm start` — run the compiled CLI

## Conventions

- **Zero runtime dependencies.** Dev dependencies are only `typescript` and
  `@types/node`. Use the standard library (`fetch`, `node:fs`, `node:readline`,
  `node:child_process`) instead of adding packages.
- **Strict TypeScript, ESM.** Relative imports must use the `.js` suffix
  (NodeNext module resolution), e.g. `import { Agent } from "./agent.js"`.
- **Provider-agnostic core.** The agent loop talks to the `Provider` interface
  in `src/provider.ts`; vendor specifics live in `src/providers/`.
- **Tools return strings.** Tool executors return human/model-readable text and
  throw `Error`s with actionable messages on failure; the agent converts thrown
  errors into tool results so the model can recover.
- **Safety first.** Anything that writes files or executes commands goes
  through `PermissionGate`. Never add a code path that bypasses it.
- **Keep files small and boring.** Readable code over clever code — people will
  fork this repo.

## Layout

- `src/cli.ts` — REPL entry point (bin)
- `src/agent.ts` — the agent loop
- `src/provider.ts` — shared provider types/interface
- `src/providers/` — model adapters (OpenAI-compatible / Ollama first)
- `src/tools/` — one file per tool, registry in `src/tools/index.ts`
- `src/permissions.ts` — approval gate
- `src/context.ts` — system prompt builder (loads `AGENTS.md`)
- `test/` — `node:test` tests, compiled to `dist/test/`
