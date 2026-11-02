// Tests for the terminal presentation layer: trace formatting helpers,
// painter/colorize behavior, the diff reveal, banner, turn panel, and fx
// resolution. All pure or captured-output — no real terminal needed.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Spinner,
  banner,
  colorizeDiff,
  createPainter,
  formatElapsed,
  formatStepHeader,
  formatToolArgs,
  formatTurnPanel,
  resolveFx,
  revealDiff,
  truncatePreview,
} from "../src/ui.js";

const paint = createPainter(true);
const plain = createPainter(false);
const ANSI = /\x1b\[/;

// --- formatElapsed / formatStepHeader --------------------------------------

test("formatElapsed renders milliseconds, seconds, and minutes", () => {
  assert.equal(formatElapsed(0), "0ms");
  assert.equal(formatElapsed(250), "250ms");
  assert.equal(formatElapsed(1200), "1.2s");
  assert.equal(formatElapsed(10_000), "10s");
  assert.equal(formatElapsed(65_000), "1m 05s");
});

test("formatStepHeader shows the step number and elapsed time", () => {
  const header = formatStepHeader(3, 1200);
  assert.match(header, /step 3/);
  assert.match(header, /1\.2s/);
  // Plain painter: no escape codes sneak in.
  assert.ok(!ANSI.test(header));
  // Enabled painter: styling is applied.
  assert.ok(ANSI.test(formatStepHeader(3, 1200, paint)));
});

// --- formatToolArgs ---------------------------------------------------------

test("formatToolArgs pretty-prints JSON arguments", () => {
  const out = formatToolArgs({ path: "src/a.ts", count: 2 });
  assert.match(out, /"path": "src\/a\.ts"/);
  assert.match(out, /"count": 2/);
  // Valid JSON that round-trips when under the cap.
  assert.deepEqual(JSON.parse(out), { path: "src/a.ts", count: 2 });
});

test("formatToolArgs caps very long arguments", () => {
  const out = formatToolArgs({ content: "x".repeat(5000) }, 200);
  assert.ok(out.length < 300);
  assert.match(out, /args truncated/);
});

// --- truncatePreview --------------------------------------------------------

test("truncatePreview keeps short results untouched", () => {
  assert.equal(truncatePreview("one\ntwo\nthree"), "one\ntwo\nthree");
  assert.equal(truncatePreview("one\ntwo\n"), "one\ntwo");
  assert.equal(truncatePreview(""), "");
});

test("truncatePreview cuts long results with a more-lines marker", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = truncatePreview(text);
  const lines = out.split("\n");
  assert.equal(lines.length, 13); // 12 kept + the marker
  assert.equal(lines[0], "line 1");
  assert.equal(lines[11], "line 12");
  assert.equal(lines[12], "… (8 more lines)");
});

test("truncatePreview uses the singular for exactly one hidden line", () => {
  const text = Array.from({ length: 13 }, (_, i) => `l${i}`).join("\n");
  assert.match(truncatePreview(text), /… \(1 more line\)$/);
});

// --- Painter and diff colorizing ---------------------------------------------

test("a disabled painter is the identity function", () => {
  for (const fn of [plain.cyan, plain.green, plain.red, plain.magenta, plain.dim, plain.bold]) {
    assert.equal(fn("text"), "text");
  }
});

test("an enabled painter wraps text in ANSI codes", () => {
  const colored = paint.green("text");
  assert.ok(ANSI.test(colored));
  assert.ok(colored.includes("text"));
  assert.ok(colored.endsWith("\x1b[0m"));
});

test("colorizeDiff is a passthrough when colors are off", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same";
  assert.equal(colorizeDiff(diff, plain), diff);
});

test("colorizeDiff colors additions, removals, and hunks when on", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same";
  const out = colorizeDiff(diff, paint);
  const lines = out.split("\n");
  assert.ok(ANSI.test(lines[2])); // @@ hunk (magenta)
  assert.ok(lines[3].includes("\x1b[31m")); // -old in red
  assert.ok(lines[4].includes("\x1b[32m")); // +new in green
  assert.equal(lines[5], " same"); // context untouched
  // Indented diff lines (as in permission prompts) are colored too.
  const indented = colorizeDiff("  +added", paint);
  assert.ok(indented.startsWith("  "));
  assert.ok(indented.includes("\x1b[32m"));
});

// --- revealDiff --------------------------------------------------------------

const SAMPLE_DIFF = ["--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n");

test("revealDiff returns the same final string with fx on and off", async () => {
  const noSleep = async () => {};
  const off = await revealDiff(SAMPLE_DIFF, { fx: false, painter: paint, sleep: noSleep });
  const on = await revealDiff(SAMPLE_DIFF, { fx: true, painter: paint, sleep: noSleep });
  assert.equal(on, off);
  // The returned string is the colorized diff in both cases.
  assert.ok(ANSI.test(off));
  assert.equal(off, colorizeDiff(SAMPLE_DIFF, paint));
});

test("revealDiff writes once when fx is off and line-by-line when on", async () => {
  const chunksOff: string[] = [];
  await revealDiff(SAMPLE_DIFF, {
    fx: false,
    write: (s) => chunksOff.push(s),
    sleep: async () => {},
  });
  assert.equal(chunksOff.length, 1);
  assert.equal(chunksOff[0], SAMPLE_DIFF + "\n");

  const chunksOn: string[] = [];
  await revealDiff(SAMPLE_DIFF, {
    fx: true,
    write: (s) => chunksOn.push(s),
    sleep: async () => {},
  });
  assert.equal(chunksOn.length, 5); // one write per diff line
  assert.equal(chunksOn.join(""), SAMPLE_DIFF + "\n");
});

test("revealDiff prints huge diffs instantly even with fx on", async () => {
  const big = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n");
  const chunks: string[] = [];
  const out = await revealDiff(big, {
    fx: true,
    write: (s) => chunks.push(s),
    sleep: async () => {},
  });
  assert.equal(chunks.length, 1);
  assert.equal(out, big);
});

// --- banner / turn panel ------------------------------------------------------

test("banner includes the product name and version", () => {
  const out = banner("0.3.0");
  assert.match(out, /hao-code/);
  assert.match(out, /v0\.3\.0/);
  assert.ok(!ANSI.test(out)); // plain by default
  assert.ok(ANSI.test(banner("0.3.0", paint)));
});

test("formatTurnPanel summarizes steps, calls, files, and tokens", () => {
  const out = formatTurnPanel({
    steps: 3,
    toolCalls: 4,
    filesChanged: ["src/a.ts", "src/b.ts"],
    usage: { inputTokens: 1234, outputTokens: 56 },
  });
  assert.match(out, /turn complete/);
  assert.match(out, /steps: 3/);
  assert.match(out, /tool calls: 4/);
  assert.match(out, /src\/a\.ts, src\/b\.ts/);
  assert.match(out, /1,234 in \/ 56 out/);

  const empty = formatTurnPanel({ steps: 1, toolCalls: 0, filesChanged: [] });
  assert.match(empty, /files changed: none/);
  assert.ok(!/tokens/.test(empty)); // no usage reported, no token line
});

// --- Spinner -------------------------------------------------------------------

test("a disabled spinner never writes", () => {
  const chunks: string[] = [];
  const spinner = new Spinner({ enabled: false, write: (s) => chunks.push(s) });
  spinner.start();
  spinner.stop();
  assert.equal(chunks.length, 0);
  assert.equal(spinner.running, false);
});

test("an enabled spinner draws braille frames and clears on stop", async () => {
  const chunks: string[] = [];
  const spinner = new Spinner({
    enabled: true,
    write: (s) => chunks.push(s),
    intervalMs: 10,
  });
  spinner.start("thinking");
  assert.equal(spinner.running, true);
  await new Promise((r) => setTimeout(r, 55));
  spinner.stop();
  assert.equal(spinner.running, false);
  const out = chunks.join("");
  assert.match(out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.ok(out.includes("\x1b[2K")); // line erased by stop()
});

// --- resolveFx ------------------------------------------------------------------

test("resolveFx: no-fx wins, flags and FORCE_FX force on, TTY is the default", () => {
  assert.equal(resolveFx({ noFxFlag: true, fxFlag: true, isTTY: true, env: { FORCE_FX: "1" } }), false);
  assert.equal(resolveFx({ fxFlag: true, isTTY: false, env: {} }), true);
  assert.equal(resolveFx({ isTTY: false, env: { FORCE_FX: "1" } }), true);
  assert.equal(resolveFx({ isTTY: true, env: {} }), true);
  assert.equal(resolveFx({ isTTY: false, env: {} }), false);
  assert.equal(resolveFx({ env: {} }), false);
});
